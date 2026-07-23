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
    const db = clientDb.db('loyverse_bot');
    usersCollection = db.collection('users');
    console.log('✅ Connected to MongoDB successfully!');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
  }
}
connectDB();




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




// กำหนดรายชื่อแอดมิน
const ADMIN_IDS = [
  "U31cdc39e686d827f23897b5da1431536",
  "Ub77ae405833d4efcca7bd15017109f14"
];




const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);




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
// 4. ฟังก์ชันการทำงานของ LINE Bot
// ==========================================
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
          { type: "text", text: "🆔 LINE User ID", weight: "bold", size: "md", color: "#333333" },
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
          { type: "text", text: title, weight: "bold", size: "md", color: "#ff7f50", wrap: true },
          { type: "text", text: description, size: "sm", color: "#555555", wrap: true, margin: "md" }
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
        backgroundColor: "#111111",
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
              { type: "text", text: `${salesData.totalSales} ฿`, size: "sm", weight: "bold", color: "#111111", align: "end" }
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
    altText: "🎁 รายการของรางวัลพิเศษจากแคสเปอร์เพ็ทช็อป",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: "https://i.postimg.cc/J7NZ2FfR/IMG-5683.png",
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "ของรางวัลสุดพิเศษ", weight: "bold", size: "lg", color: "#333333" },
          { type: "text", text: "ใช้แต้มสะสมแลกรับของรางวัลมากมาย", size: "sm", color: "#666666", margin: "sm" }
        ],
        spacing: "sm",
        paddingAll: "lg"
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "🎁 คลิกดูของรางวัล",
              uri: "https://liff.line.me/2010783485-TIIRDjGm"
            },
            style: "primary",
            color: "#ff7f50"
          }
        ],
        paddingAll: "lg"
      }
    }
  };
}




function getPointFlexMessage(customerName, points, phone, isNewSaved = false) {
  const contentsList = [];




  if (isNewSaved) {
    contentsList.push({
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: "📌", size: "xs", flex: 0 },
        { type: "text", text: `บันทึกเบอร์ ${phone} สำเร็จ!`, size: "xs", weight: "bold", color: "#1DB446", margin: "sm" }
      ],
      backgroundColor: "#f0fdf4",
      paddingAll: "sm",
      cornerRadius: "md"
    });
    contentsList.push({ type: "separator", margin: "md" });
  }




  contentsList.push({
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", text: `${customerName || 'ลูกค้าคนสำคัญ'}`, weight: "bold", size: "md", color: "#333333", align: "center" },
      { type: "text", text: `เบอร์โทรศัพท์: ${phone}`, size: "xs", color: "#888888", align: "center", margin: "xs" }
    ],
    margin: "md"
  });




  contentsList.push({ type: "separator", margin: "lg" });




  contentsList.push({
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", text: `${points}`, weight: "bold", size: "4xl", color: "#ff7f50", align: "center" },
      { type: "text", text: "✨ แต้มสะสมของคุณ ✨", size: "xs", color: "#aaaaaa", align: "center", margin: "sm" }
    ],
    margin: "lg",
    backgroundColor: "#fffaf5",
    paddingAll: "md",
    cornerRadius: "lg"
  });




  return {
    type: "flex",
    altText: `✨ บัตรสะสมแต้มสมาชิกของ ${customerName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🐾 CASPER PETSHOP 🐾", weight: "bold", size: "xs", color: "#ffffff", align: "center" },
          { type: "text", text: "บัตรสะสมแต้มสมาชิก", weight: "bold", size: "md", color: "#ffffff", align: "center", margin: "sm" }
        ],
        backgroundColor: "#ff7f50",
        paddingAll: "lg"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: contentsList
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "🎁 ดูของรางวัล",
              uri: "https://liff.line.me/2010783485-TIIRDjGm"
            },
            style: "primary",
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
        backgroundColor: "#111111",
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




async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }




  const userMessage = event.message.text.trim();
  const lowerMsg = userMessage.toLowerCase();
  const senderId = event.source.userId;




  if (lowerMsg === "ไอดีฉัน" || lowerMsg === "id") {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [getUserIdFlexMessage(senderId)]
    });
  }




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
          success ? `สั่งอัปเดต Rich Menu (${newRichMenuId}) ให้ลูกค้าทุกคนเรียบร้อยแล้วครับ!` : "อัปเดตไม่สำเร็จ ตรวจสอบ ID หรือ Log อีกครั้ง"
        )
      ]
    });
  }




  if (userMessage === "ยอดขาย" || userMessage === "#ยอดขาย" || userMessage === "กำไร") {
    if (!ADMIN_IDS.includes(senderId)) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [getAdminNoticeFlexMessage("⛔ ไม่มีสิทธิ์เข้าถึง", "คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นครับ")]
      });
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
          messages: [getPointFlexMessage(customerName, points, phoneNumber, true)]
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
          messages: [getPointFlexMessage(customerName, points, savedPhone, false)]
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
// 5. ระบบส่งรายงานประจำวันอัตโนมัติ ( 22:00 น. )
// ==========================================
cron.schedule('0 22 * * *', async () => {
  console.log('⏰ ถึงเวลา 22:00 น. เริ่มส่งรายงานประจำวัน...');
 
  if (ADMIN_IDS.length === 0) return;




  const salesData = await getDailySales();
  if (!salesData) return;




  const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });




  try {
    // วนลูปส่งรายงานไปหาแอดมินทุกคนที่มีใน ADMIN_IDS
    for (const adminId of ADMIN_IDS) {
        await client.pushMessage({
            to: adminId,
            messages: [getSalesFlexMessage(salesData, todayStr)]
        });
    }
    console.log('✅ ส่งรายงานยอดขายประจำวันเรียบร้อยแล้ว!');
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


