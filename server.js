require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();

// ==========================================
// 0. ระบบจัดการฐานข้อมูลไฟล์ JSON (บันทึกเบอร์ถาวร)
// ==========================================
const DB_FILE = path.join(__dirname, 'users.json');

// ฟังก์ชันอ่านข้อมูลผู้ใช้จากไฟล์
function loadUserData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading user data file:', error);
  }
  return {};
}

// ฟังก์ชันบันทึกข้อมูลผู้ใช้ลงไฟล์
function saveUserData(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing user data file:', error);
  }
}

// ==========================================
// 1. ดึงค่า Environment Variables จาก .env
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || '').trim();
const LOYVERSE_TOKEN = (process.env.LOYVERSE_TOKEN || '').trim();
const TARGET_USER_OR_GROUP_ID = (process.env.TARGET_USER_OR_GROUP_ID || '').trim();

// ตั้งค่า LINE Bot
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

// ==========================================
// 2. Webhook & Endpoint สำหรับ LINE
// ==========================================
app.get('/', (req, res) => {
  res.send('Loyverse Bot & Daily Report Service is running!');
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
// 4. ฟังก์ชันการทำงานของ LINE Bot (จัดการข้อความ)
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

// สร้าง Flex Message แสดงของรางวัล
function getRewardFlexMessage() {
  return {
    type: "flex",
    altText: "รายการของรางวัลสะสมแต้ม 🎁",
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
              { type: "text", text: "ส่วนลด 50 บาท", weight: "bold", size: "xl" },
              { type: "text", text: "ใช้ 50 แต้มสะสม", size: "sm", color: "#888888", margin: "md" }
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
                color: "#ff7f50"
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
              { type: "text", text: "แก้วน้ำ Casper", weight: "bold", size: "xl" },
              { type: "text", text: "ใช้ 100 แต้มสะสม", size: "sm", color: "#888888", margin: "md" }
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
                color: "#4682b4"
              }
            ]
          }
        }
      ]
    }
  };
}

// จัดการข้อความที่ส่งมาจาก LINE
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  const senderId = event.source.userId; // ดึง User ID ของคนที่พิมพ์เข้ามา

  // 0. คำสั่งเรียกดูยอดขายและกำไร (ล็อกเฉพาะ User ID ของคุณเท่านั้น!)
  if (userMessage === "ยอดขาย" || userMessage === "#ยอดขาย" || userMessage === "กำไร") {
    if (senderId !== TARGET_USER_OR_GROUP_ID) {
      console.log(`⚠️ มีคนอื่นพยายามดูยอดขาย (UserId: ${senderId}) ระบบไม่อนุญาต`);
      return Promise.resolve(null);
    }

    const salesData = await getDailySales();
    const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
   
    const replyText = salesData
      ? `📈 สรุปยอดขาย & กำไร (ณ ปัจจุบัน)\n📅 วันที่: ${todayStr}\n\n💵 ยอดขายรวม: ${salesData.totalSales} บาท\n💰 กำไรสุทธิ: ${salesData.netProfit} บาท\n🧾 จำนวนบิลทั้งหมด: ${salesData.totalReceipts} บิล`
      : '❌ ไม่สามารถดึงข้อมูลยอดขายจากระบบได้ในขณะนี้';

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }]
    });
  }

  // 1. คำสั่งแสดงของรางวัล
  if (userMessage === "ของรางวัล" || userMessage === "#ของรางวัล") {
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
        type: "text",
        text: `🎁 คุณเลือกแลก "${rewardName}" (ใช้ ${requiredPoints} แต้ม)\n\nกรุณาแจ้งเบอร์โทรศัพท์กับพนักงานหน้าร้านเพื่อตรวจสอบแต้มสะสมและรับของรางวัลได้เลยครับ! ✨`
      }]
    });
  }

  // 3. ตรวจสอบการพิมพ์คำว่า "เช็คแต้ม" + เบอร์โทรศัพท์ (บันทึกลงไฟล์ JSON ถาวร)
  const matchWithPhone = userMessage.match(/^เช็คแต้ม\s*(\d{9,10})$/);

  if (matchWithPhone) {
    const phoneNumber = matchWithPhone[1];
    
    // โหลดข้อมูลเดิมมาอัปเดต และบันทึกลงไฟล์ JSON
    const users = loadUserData();
    users[senderId] = phoneNumber;
    saveUserData(users);

    try {
      const matchedCustomer = await findCustomerByPhone(phoneNumber);

      if (matchedCustomer) {
        const points = matchedCustomer.total_points || 0;
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `📌 (บันทึกเบอร์เรียบร้อยครับ)\nสวัสดีครับ ${matchedCustomer.name || 'ลูกค้า'}\nตอนนี้มีแต้มสะสมทั้งหมด: ${points} แต้มครับ ✨`
          }]
        });
      } else {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `ขออภัยไม่พบข้อมูลสมาชิกของเบอร์ ${phoneNumber} ในระบบสะสมแต้ม\n\nหากเพิ่งสมัครใหม่ รบกวนแจ้งพนักงานหน้าร้านเพื่อตรวจสอบการคีย์เบอร์โทรศัพท์ในระบบอีกครั้งนะครับ🙏`
          }]
        });
      }

    } catch (error) {
      console.error('Error in handleEvent:', error);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: 'เกิดข้อผิดพลาดในการดึงข้อมูลแต้ม กรุณาลองใหม่อีกครั้งในภายหลังครับ'
        }]
      });
    }
  }

  // 4. กรณีพิมพ์เฉพาะคำว่า "เช็คแต้ม" / "#เช็คแต้ม" / "แต้ม" (ดึงเบอร์จากไฟล์ JSON มาเช็คให้เลย)
  const isOnlyCheckPoints = userMessage === '#เช็คแต้ม' || userMessage === 'เช็คแต้ม' || userMessage === 'แต้ม';
  const isOnlyPhoneNumber = /^\d{9,10}$/.test(userMessage);

  if (isOnlyCheckPoints || isOnlyPhoneNumber) {
    const users = loadUserData();
    const savedPhone = users[senderId];

    // ถ้ายังไม่เคยบันทึกเบอร์ไว้
    if (!savedPhone) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: 'สวัสดีครับ 🐾 ยินดีต้อนรับสู่ระบบสะสมแต้ม!\n\n✨ สำหรับการใช้งานครั้งแรก:\nกรุณาพิมพ์คำว่า "เช็คแต้ม" ตามด้วยเบอร์โทรศัพท์ของคุณติดกัน (เช่น เช็คแต้ม0812345678) เพื่อให้ระบบบันทึกความจำไว้ครับ\n\n🔄 สำหรับการใช้งานครั้งถัดไป:\nสามารถพิมพ์แค่คำว่า "เช็คแต้ม" หรือ "แต้ม" เฉยๆ เพื่อตรวจสอบยอดได้ทันทีโดยไม่ต้องพิมพ์เบอร์ซ้ำครับ! 😊'
        }]
      });
    }

    // ถ้ามีเบอร์ที่จำไว้แล้ว ดึงแต้มให้ทันที
    try {
      const matchedCustomer = await findCustomerByPhone(savedPhone);

      if (matchedCustomer) {
        const points = matchedCustomer.total_points || 0;
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `🔍 ดึงข้อมูลจากเบอร์ที่บันทึกไว้ (${savedPhone}):\nสวัสดีครับ ${matchedCustomer.name || 'ลูกค้า'}\nตอนนี้มีแต้มสะสมทั้งหมด: ${points} แต้มครับ ✨\n\n*(หากต้องการเปลี่ยนเบอร์ ให้พิมพ์ เช็คแต้ม ตามด้วยเบอร์ใหม่ได้เลยครับ)*`
          }]
        });
      } else {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `❌ ไม่พบข้อมูลสมาชิกของเบอร์ที่บันทึกไว้ (${savedPhone})\nกรุณาพิมพ์ "เช็คแต้ม" ตามด้วยเบอร์ใหม่อีกครั้งเพื่ออัปเดตครับ`
          }]
        });
      }
    } catch (error) {
      console.error('Error in JSON check:', error);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: 'เกิดข้อผิดพลาดในการดึงข้อมูลแต้ม กรุณาลองใหม่อีกครั้งในภายหลังครับ'
        }]
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
 
  if (!TARGET_USER_OR_GROUP_ID) {
    console.log('❌ ไม่พบ TARGET_USER_OR_GROUP_ID ใน .env');
    return;
  }

  const salesData = await getDailySales();
  if (!salesData) return;

  const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const messageText = `📈 สรุปยอดขาย & กำไรประจำวัน 📈\n📅 วันที่: ${todayStr}\n\n💵 ยอดขายรวม: ${salesData.totalSales} บาท\n💰 กำไรสุทธิ: ${salesData.netProfit} บาท\n🧾 จำนวนบิลทั้งหมด: ${salesData.totalReceipts} บิล\n\nขอบคุณสำหรับความตั้งใจทำงานในวันนี้ครับ! ✨`;

  try {
    await client.pushMessage({
      to: TARGET_USER_OR_GROUP_ID,
      messages: [{ type: 'text', text: messageText }]
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


