require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const { MongoClient } = require('mongodb');

const app = express();

// ==========================================
// 0. ระบบจัดการฐานข้อมูล MongoDB (บันทึกเบอร์ถาวร)
// ==========================================
const mongoUri = process.env.MONGODB_URI;
const clientDb = new MongoClient(mongoUri);

let usersCollection;

async function connectDB() {
  try {
    await clientDb.connect();
    const db = clientDb.db('loyverse_bot'); // ชื่อฐานข้อมูล
    usersCollection = db.collection('users'); // ชื่อ Collection
    console.log('✅ Connected to MongoDB successfully!');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
  }
}
connectDB();

// ฟังก์ชันอ่านข้อมูลผู้ใช้จาก MongoDB
async function getUserData(lineUserId) {
  try {
    if (!usersCollection) return null;
    const user = await usersCollection.findOne({ lineUserId: lineUserId });
    return user ? user.phone : null;
  } catch (error) {
    console.error('Error reading user data from MongoDB:', error);
    return null;
  }
}

// ฟังก์ชันบันทึกข้อมูลผู้ใช้ลง MongoDB
async function saveUserData(lineUserId, phone) {
  try {
    if (!usersCollection) return;
    await usersCollection.updateOne(
      { lineUserId: lineUserId },
      { $set: { phone: phone, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error writing user data to MongoDB:', error);
  }
}

// ==========================================
// 1. ดึงค่า Environment Variables จาก .env
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || '').trim();
const LOYVERSE_TOKEN = (process.env.LOYVERSE_TOKEN || '').trim();

// กำหนดรายชื่อแอดมินตรงนี้แบบถาวร ป้องกันปัญหาการอ่านค่า .env เพี้ยน
const ADMIN_IDS = [
  "U319eWJh8J6Mx9DrGXKEv3ojKmqw8Cv9pscK",
  "Ub77ae405833d4efcca7bd15017109f14"
];

// ตั้งค่า LINE Bot
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

// ฟังก์ชันสำหรับบังคับเปลี่ยน Default Rich Menu ให้กับผู้ใช้ทุกคนผ่าน API (อัปเดตให้ลูกค้าทุกคนพร้อมกันทันที)
async function setDefaultRichMenuGlobal(richMenuId) {
  try {
    await client.setDefaultRichMenu(richMenuId);
    console.log(`✅ บังคับเปลี่ยน Default Rich Menu เป็น ID: ${richMenuId} สำเร็จเรียบร้อย!`);
    return true;
  } catch (error) {
    console.error('❌ ไม่สามารถเปลี่ยน Default Rich Menu ได้:', error.message);
    return false;
  }
}

// ==========================================
// 2. Webhook & Endpoint สำหรับ LINE
// ==========================================
app.get('/', (req, res) => {
  res.send('Loyverse Bot & Daily Report Service is running with MongoDB & Multi-Admin Rich Menu!');
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ==========================================
// 3. ฟังก์ชันดึงข้อมูลยอดขายและกำไร
// ==========================================
async function getDailySales() {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    const response = await axios.get('https://api.loyverse.com/v1.0/receipts', {
      headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` },
      params: { created_at_min: startOfDay, created_at_max: endOfDay, limit: 250 }
    });

    const receipts = response.data.receipts || [];
    let totalSales = 0, totalCost = 0;

    receipts.forEach(receipt => {
      totalSales += receipt.total_money || 0;
      if (receipt.line_items) {
        receipt.line_items.forEach(item => {
          totalCost += ((item.cost || 0) * (item.quantity || 1));
        });
      }
    });

    return {
      totalSales: totalSales.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      netProfit: (totalSales - totalCost).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      totalReceipts: receipts.length
    };
  } catch (error) {
    console.error('Error fetching Loyverse receipts:', error.message);
    return null;
  }
}

// ==========================================
// 4. ฟังก์ชันการทำงานของ LINE Bot (จัดการข้อความ & ออกแบบ Flex Message)
// ==========================================

// ค้นหาข้อมูลลูกค้าใน Loyverse ด้วยเบอร์โทรศัพท์ (วนลูปตาม Cursor)
async function findCustomerByPhone(phoneNumber) {
  let cursor = null;

  do {
    let url = `https://api.loyverse.com/v1.0/customers?limit=250`;
    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${LOYVERSE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      const customers = response.data.customers || [];
      const matchedCustomer = customers.find(c => {
        const phoneInSystem = c.phone_number ? c.phone_number.replace(/\s+/g, '') : '';
        return phoneInSystem === phoneNumber;
      });

      if (matchedCustomer) {
        return matchedCustomer;
      }

      cursor = response.data.cursor;
    } catch (error) {
      console.error("Error fetching customers from Loyverse:", error.message);
      break;
    }

  } while (cursor);

  return null;
}

// --- รวมฟังก์ชัน Flex Message ดีไซน์สวยงาม ---

function getUserIdFlexMessage(userId) {
  return {
    type: "flex",
    altText: "🆔 User ID ของคุณ",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🆔 LINE User ID", weight: "bold", size: "md", color: "#555555" },
          { type: "text", text: userId, size: "xs", color: "#888888", wrap: true, margin: "md" }
        ]
      }
    }
  };
}

function getAdminNoticeFlexMessage(title, description) {
  return {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: title, weight: "bold", size: "md", color: "#1DB446", wrap: true },
          { type: "text", text: description, size: "sm", color: "#666666", wrap: true, margin: "md" }
        ]
      }
    }
  };
}

function getSalesFlexMessage(salesData, todayStr) {
  return {
    type: "flex",
    altText: "📈 สรุปยอดขาย & กำไรประจำวัน",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📈 สรุปยอดขาย & กำไร", weight: "bold", size: "lg", color: "#ffffff", align: "center" },
          { type: "text", text: `📅 ${todayStr}`, size: "xs", color: "#ffffff", align: "center", margin: "sm" }
        ],
        backgroundColor: "#0066cc",
        paddingAll: "lg"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "💵 ยอดขายรวม", size: "sm", color: "#555555" },
              { type: "text", text: `${salesData.totalSales} ฿`, size: "sm", weight: "bold", color: "#0066cc", align: "end" }
            ],
            margin: "md"
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "💰 กำไรสุทธิ", size: "sm", color: "#555555" },
              { type: "text", text: `${salesData.netProfit} ฿`, size: "sm", weight: "bold", color: "#1DB446", align: "end" }
            ],
            margin: "md"
          },
          { type: "separator", margin: "lg" },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "🧾 บิลทั้งหมด", size: "xs", color: "#aaaaaa" },
              { type: "text", text: `${salesData.totalReceipts} บิล`, size: "xs", color: "#aaaaaa", align: "end" }
            ],
            margin: "md"
          }
        ]
      }
    }
  };
}

function getRewardFlexMessage() {
  return {
    type: "flex",
    altText: "🎁 รายการของรางวัลสะสมแต้ม แคสเปอร์ เพ็ทช็อป",
    contents: {
      type: "carousel",
      contents: [
        {
          type: "bubble",
          hero: {
            type: "image",
            url: "https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=600&auto=format&fit=crop&q=60",
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "ส่วนลด 50 บาท", weight: "bold", size: "xl", color: "#1DB446" },
              { type: "text", text: "ใช้ 50 แต้มสะสมแลกรับส่วนลดทันที", size: "sm", color: "#666666", margin: "md", wrap: true }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                action: { type: "message", label: "กดแลกรางวัล (50 แต้ม)", text: "#แลกรางวัล 50 ส่วนลด 50" },
                style: "primary",
                color: "#1DB446"
              }
            ]
          }
        },
        {
          type: "bubble",
          hero: {
            type: "image",
            url: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=600&auto=format&fit=crop&q=60",
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "แก้วน้ำพรีเมียม Casper", weight: "bold", size: "xl", color: "#0066cc" },
              { type: "text", text: "ใช้ 100 แต้มสะสมแลกรับของที่ระลึกสุดน่ารัก", size: "sm", color: "#666666", margin: "md", wrap: true }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                action: { type: "message", label: "กดแลกรางวัล (100 แต้ม)", text: "#แลกรางวัล 100 แก้วน้ำ Casper" },
                style: "primary",
                color: "#0066cc"
              }
            ]
          }
        }
      ]
    }
  };
}

function getPointFlexMessage(customerName, points, phone) {
  return {
    type: "flex",
    altText: `✨ ยอดแต้มสะสมของคุณ ${customerName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🐾 CASPER PETSHOP 🐾", weight: "bold", size: "xs", color: "#ffffff", align: "center" },
          { type: "text", text: "ยอดแต้มสะสมของคุณ", weight: "bold", size: "lg", color: "#ffffff", align: "center", margin: "sm" }
        ],
        backgroundColor: "#ff7f50",
        paddingAll: "lg"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: `คุณ ${customerName || 'ลูกค้าคนสำคัญ'}`, weight: "bold", size: "md", align: "center" },
          { type: "text", text: `เบอร์โทร: ${phone}`, size: "xs", color: "#aaaaaa", align: "center", margin: "sm" },
          { type: "separator", margin: "xxl" },
          {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: `${points}`, weight: "bold", size: "3xl", color: "#ff7f50", align: "center" },
              { type: "text", text: "แต้มสะสม", size: "sm", color: "#888888", align: "center" }
            ],
            margin: "xxl"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: { type: "message", label: "🎁 ดูของรางวัล", text: "ของรางวัล" },
            style: "secondary",
            color: "#ff7f50"
          }
        ]
      }
    }
  };
}

function getWelcomeHelpFlexMessage() {
  return {
    type: "flex",
    altText: "✨ ยินดีต้อนรับสู่ระบบสะสมแต้ม",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🐾 CASPER PETSHOP 🐾", weight: "bold", size: "sm", color: "#ffffff", align: "center" },
          { type: "text", text: "ระบบสมาชิก & สะสมแต้ม", weight: "bold", size: "md", color: "#ffffff", align: "center", margin: "sm" }
        ],
        backgroundColor: "#1DB446",
        paddingAll: "md"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📌 วิธีใช้งานครั้งแรก:", weight: "bold", size: "sm", color: "#333333" },
          { type: "text", text: 'พิมพ์ "เช็คแต้ม" ตามด้วยเบอร์โทร เช่น เช็คแต้ม0812345678 เพื่อบันทึกข้อมูล', size: "xs", color: "#666666", wrap: true, margin: "sm" },
          { type: "separator", margin: "lg" },
          { type: "text", text: "🔄 ใช้งานครั้งถัดไป:", weight: "bold", size: "sm", color: "#333333", margin: "lg" },
          { type: "text", text: 'พิมพ์คำว่า "แต้ม" เฉยๆ เพื่อเช็คยอดคะแนนได้ทันทีไม่ต้องพิมพ์เบอร์ซ้ำ', size: "xs", color: "#666666", wrap: true, margin: "sm" }
        ]
      }
    }
  };
}

// จัดการข้อความที่ส่งมาจาก LINE
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  const senderId = event.source.userId;

  // 0.0 คำสั่งเช็ค User ID ของตัวเอง
  if (userMessage === "ไอดีฉัน" || userMessage === "id") {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [getUserIdFlexMessage(senderId)]
    });
  }

  // 0.1 คำสั่งสำหรับแอดมิน: บังคับอัปเดต Rich Menu ใหม่ให้ลูกค้าทุกคนทันที
  if (userMessage.startsWith("#เปลี่ยนริชเมนู")) {
    if (!ADMIN_IDS.includes(senderId)) {
      return Promise.resolve(null);
    }

    const newRichMenuId = userMessage.replace("#เปลี่ยนริชเมนู", "").trim();
    if (!newRichMenuId) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getAdminNoticeFlexMessage("❌ รูปแบบไม่ถูกต้อง", "กรุณาใส่ Rich Menu ID ต่อท้ายด้วย เช่น #เปลี่ยนริชเมนู 9408661")]
      });
    }

    const success = await setDefaultRichMenuGlobal(newRichMenuId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        getAdminNoticeFlexMessage(
          success ? "✅ สำเร็จ" : "❌ ล้มเหลว",
          success ? `สั่งอัปเดต Rich Menu (${newRichMenuId}) ให้ลูกค้าทุกคนเรียบร้อยแล้วครับ!` : "อัปเดตไม่สำเร็จ ตรวจสอบ ID หรือ Log ของ Server อีกครั้ง"
        )
      ]
    });
  }

  // 0.2 คำสั่งเรียกดูยอดขายและกำไร (ล็อกเฉพาะกลุ่มแอดมินเท่านั้น!)
  if (userMessage === "ยอดขาย" || userMessage === "#ยอดขาย" || userMessage === "กำไร") {
    if (!ADMIN_IDS.includes(senderId)) {
      return Promise.resolve(null);
    }

    const salesData = await getDailySales();
    const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
    
    if (!salesData) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getAdminNoticeFlexMessage("❌ ดึงข้อมูลไม่สำเร็จ", "ไม่สามารถดึงข้อมูลยอดขายจากระบบได้ในขณะนี้")]
      });
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [getSalesFlexMessage(salesData, todayStr)]
    });
  }

  // 1. คำสั่งแสดงของรางวัล
  if (userMessage === "ของรางวัล" || userMessage === "#ของรางวัล" || userMessage === "โปรโมชั่น") {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [getRewardFlexMessage()]
    });
  }

  // 2. คำสั่งเมื่อลูกค้ากดปุ่มแลกรางวัล
  if (userMessage.startsWith("#แลกรางวัล")) {
    const rawContent = userMessage.replace("#แลกรางวัล", "").trim();
    const firstSpaceIndex = rawContent.indexOf(" ");
    
    let requiredPoints = 0;
    let rewardName = "";

    if (firstSpaceIndex !== -1) {
      requiredPoints = parseFloat(rawContent.substring(0, firstSpaceIndex)) || 0;
      rewardName = rawContent.substring(firstSpaceIndex + 1).trim();
    } else {
      rewardName = rawContent;
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: "flex",
        altText: `🎁 แลกรางวัล: ${rewardName}`,
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "🎁 ทำรายการแลกรางวัล", weight: "bold", size: "md", color: "#1DB446" },
              { type: "text", text: `คุณเลือกแลก "${rewardName}" (ใช้ ${requiredPoints} แต้ม)`, size: "sm", color: "#333333", wrap: true, margin: "md" },
              { type: "separator", margin: "lg" },
              { type: "text", text: "กรุณาแจ้งเบอร์โทรศัพท์กับพนักงานหน้าร้านเพื่อตรวจสอบแต้มและรับของรางวัลได้เลยครับ! ✨", size: "xs", color: "#888888", wrap: true, margin: "lg" }
            ]
          }
        }
      }]
    });
  }

  // 3. ตรวจสอบการพิมพ์คำว่า "เช็คแต้ม" + เบอร์โทรศัพท์
  const matchWithPhone = userMessage.match(/^เช็คแต้ม\s*(\d{9,10})$/);

  if (matchWithPhone) {
    const phoneNumber = matchWithPhone[1];
    await saveUserData(senderId, phoneNumber);

    try {
      const matchedCustomer = await findCustomerByPhone(phoneNumber);

      if (matchedCustomer) {
        const points = matchedCustomer.total_points || 0;
        const customerName = matchedCustomer.name || 'ลูกค้า';
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            getAdminNoticeFlexMessage("📌 บันทึกเบอร์โทรศัพท์เรียบร้อย", `ระบบบันทึกเบอร์ ${phoneNumber} สำเร็จแล้วครับ`),
            getPointFlexMessage(customerName, points, phoneNumber)
          ]
        });
      } else {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [getAdminNoticeFlexMessage("❌ ไม่พบข้อมูล", `ขออภัยไม่พบข้อมูลสมาชิกของเบอร์ ${phoneNumber} ในระบบสะสมแต้ม\n\nหากเพิ่งสมัครใหม่ รบกวนแจ้งพนักงานหน้าร้านเพื่อตรวจสอบการคีย์เบอร์โทรศัพท์ในระบบอีกครั้งนะครับ🙏`)]
        });
      }
    } catch (error) {
      console.error('Error in handleEvent:', error);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getAdminNoticeFlexMessage("❌ เกิดข้อผิดพลาด", "ไม่สามารถดึงข้อมูลแต้มได้ กรุณาลองใหม่อีกครั้ง")]
      });
    }
  }

  // 4. กรณีพิมพ์เฉพาะคำว่า "เช็คแต้ม" / "แต้ม"
  const isOnlyCheckPoints = userMessage === '#เช็คแต้ม' || userMessage === 'เช็คแต้ม' || userMessage === 'แต้ม';
  const isOnlyPhoneNumber = /^\d{9,10}$/.test(userMessage);

  if (isOnlyCheckPoints || isOnlyPhoneNumber) {
    const savedPhone = await getUserData(senderId);

    if (!savedPhone) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getWelcomeHelpFlexMessage()]
      });
    }

    try {
      const matchedCustomer = await findCustomerByPhone(savedPhone);

      if (matchedCustomer) {
        const points = matchedCustomer.total_points || 0;
        const customerName = matchedCustomer.name || 'ลูกค้า';
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [getPointFlexMessage(customerName, points, savedPhone)]
        });
      } else {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [getAdminNoticeFlexMessage("❌ ไม่พบข้อมูลสมาชิก", `ไม่พบข้อมูลของเบอร์ที่บันทึกไว้ (${savedPhone})\nกรุณาพิมพ์ "เช็คแต้ม" ตามด้วยเบอร์ใหม่อีกครั้งเพื่ออัปเดตครับ`)]
        });
      }
    } catch (error) {
      console.error('Error in MongoDB check:', error);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getAdminNoticeFlexMessage("❌ เกิดข้อผิดพลาด", "ไม่สามารถดึงข้อมูลแต้มได้ กรุณาลองใหม่อีกครั้ง")]
      });
    }
  }

  return Promise.resolve(null);
}

// ==========================================
// 5. ระบบส่งรายงานประจำวันอัตโนมัติ ( Cron Job เวลา 22:00 น. )
// ==========================================
cron.schedule('0 22 * * *', async () => {
  console.log('⏰ ถึงเวลา 22:00 น. เริ่มส่งรายงานประจำวัน...');
  
  if (ADMIN_IDS.length === 0) {
    console.log('❌ ไม่พบรายชื่อแอดมินในระบบ');
    return;
  }

  const salesData = await getDailySales();
  if (!salesData) return;

  const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });

  // ส่งรายงานไปยังแอดมินคนแรกในรูปแบบ Flex Message
  try {
    await client.pushMessage({
      to: ADMIN_IDS[0],
      messages: [getSalesFlexMessage(salesData, todayStr)]
    });
    console.log('✅ ส่งรายงานยอดขายประจำวันเรียบร้อย!');
  } catch (err) {
    console.error('❌ ส่งรายงานไม่สำเร็จ:', err.message);
  }
}, { timezone: "Asia/Bangkok" });

// ==========================================
// 6. เริ่มต้นเปิด Server
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});


