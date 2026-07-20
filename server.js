const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ตั้งค่า LINE Bot
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);
// ตั้งค่า Loyverse API
const LOYVERSE_API_URL = 'https://api.loyverse.com/v1.0/customers';
const LOYVERSE_TOKEN = process.env.LOYVERSE_TOKEN;

// Webhook endpoint สำหรับ LINE
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function findCustomerByPhone(phoneNumber) {
  let cursor = null;
  
  do {
    // 1. สร้าง URL พร้อมพารามิเตอร์ limit=250 และ cursor (ถ้ามี)
    let url = `https://api.loyverse.com/v1.0/customers?limit=250`;
    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    // 2. ส่ง Request ไปยัง Loyverse API
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.LOYVERSE_TOKEN}`, // หรือชื่อตัวแปร Token ของคุณ
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    const customers = data.customers || [];

    // 3. ค้นหาเบอร์โทรศัพท์ในชุดข้อมูล 250 คนนี้
    const matchedCustomer = customers.find(c => c.phone_number === phoneNumber);
    if (matchedCustomer) {
      return matchedCustomer; // เจอแล้ว! คืนค่าข้อมูลลูกค้าคนนี้ทันที
    }

    // 4. อัปเดต cursor สำหรับดึงข้อมูลชุดถัดไป (ถ้าไม่มีแล้วจะหยุดลูป)
    cursor = data.cursor;

  } while (cursor);

  return null; // หาไม่เจอจนถึงคนสุดท้าย
}
// ฟังก์ชันสร้าง Flex Message แสดงของรางวัล
function getRewardFlexMessage() {
  return {
    type: "flex",
    altText: "รายการของรางวัลสะสมแต้ม 🎁",
    contents: {
      type: "carousel",
      contents: [
        // Card 1: คูปองส่วนลด 50 บาท
        {
          type: "bubble",
          hero: {
            type: "image",
            url: "https://i.postimg.cc/k5ZSZHmp/test01.png", // เปลี่ยนเป็น URL รูปจริง
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "คูปองส่วนลด 50 บาท", weight: "bold", size: "xl" },
              { type: "text", text: "ใช้ 50 แต้มสะสม", size: "sm", color: "#888888", margin: "md" }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                action: {
                  type: "message",
                  label: "กดแลกรางวัล (50 แต้ม)",
                  text: "#แลกรางวัล 50ส่วนลด 50"
                },
                style: "primary",
                color: "#ff7f50"
              }
            ]
          }
        },
        // Card 2: สินค้าพิเศษ / แก้วน้ำ
        {
          type: "bubble",
          hero: {
            type: "image",
            url: "https://i.postimg.cc/k5ZSZHmp/test01.png", // เปลี่ยนเป็น URL รูปจริง
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "แก้วน้ำ Casper Petshop", weight: "bold", size: "xl" },
              { type: "text", text: "ใช้ 100 แต้มสะสม", size: "sm", color: "#888888", margin: "md" }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                action: {
                  type: "message",
                  label: "กดแลกรางวัล (100 แต้ม)",
                  text: "#แลกรางวัล 100แก้วน้ำ Casper"
                },
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



// ฟังก์ชันจัดการข้อความที่ส่งมาจาก LINE
async function handleEvent(event) {
  // ตรวจสอบว่าต้องเป็นข้อความตัวหนังสือเท่านั้น
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

    const userMessage = event.message.text.trim();
    const userMessage = event.message.text.trim();

// 1. ถ้าลูกค้าพิมพ์คำว่า "ของรางวัล" หรือ "#ของรางวัล" -> ส่งการ์ด Flex Message ให้ดู
if (userMessage === "ของรางวัล" || userMessage === "#ของรางวัล") {
  return client.replyMessage(event.replyToken, getRewardFlexMessage());
}

// 2. ถ้าลูกค้ากดปุ่มแลกรางวัล (เช่น "#แลกรางวัล 50ส่วนลด 50")
if (userMessage.startsWith("#แลกรางวัล")) {
  // แยกแต้มที่ต้องใช้ และ ชื่อรางวัล
  const parts = userMessage.replace("#แลกรางวัล ", "").split(/(?<=\d+)/);
  const requiredPoints = parseFloat(parts[0]);
  const rewardName = parts[1];

  // ดึงโปรไฟล์ LINE ของลูกค้าหาเบอร์โทร (หรือถ้ามีเก็บเบอร์ไว้ใน Session/DB)
  // *ตัวอย่างกรณีเช็คแต้มจาก Loyverse ด้วยเบอร์โทรศัพท์ลูกค้า*
  const customer = await findCustomerByPhone(userPhoneNumber); 

  if (!customer) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ ไม่พบข้อมูลสมาชิก กรุณาแจ้งเบอร์โทรศัพท์เพื่อเช็คแต้มก่อนนะครับ"
    });
  }

  const currentPoints = customer.total_points || 0;

  // เช็คว่าแต้มพอหรือไม่
  if (currentPoints >= requiredPoints) {
    // แต้มพอ -> ส่งรหัสแลกรางวัลให้ลูกค้าเอาไปยื่นหน้าร้าน
    const redeemCode = "REDEEM-" + Math.floor(1000 + Math.random() * 9000);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `🎉 ยินดีด้วยครับ! คุณมีแต้มเพียงพอสำหรับแลก "${rewardName}"\n\n🔑 รหัสแลกรางวัลของคุณคือ: ${redeemCode}\n\nกรุณาแสดงหน้าจอนี้ให้พนักงานหน้าร้าน เพื่อตัดแต้มสะสมจำนวน ${requiredPoints} แต้มและรับของรางวัลครับ ✨`
    });
  } else {
    // แต้มไม่พอ
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `😅 ขออภัยครับ คุณมีแต้มสะสมอยู่ ${currentPoints} แต้ม ซึ่งยังไม่พอสำหรับแลก "${rewardName}" (ต้องใช้ ${requiredPoints} แต้ม)`
    });
  }
}



    const customer = await findCustomerByPhone(phoneNumber);

if (customer) {
    // เจอลูกค้า -> เอาแต้มส่งกลับให้ LINE
    const points = customer.total_points || 0;
    // ... ส่งข้อความบอกแต้มลูกค้า
} else {
    // ไม่พบลูกค้าในระบบ
}
 
  // 1. ตรวจสอบว่าเป็นข้อความตัวอักษรพิมพ์เข้ามาไหม
  if (event.type === 'message' && event.message.type === 'text') {
    const userMessage = event.message.text.trim();

    // 🔍 ใช้ Regex ตรวจสอบว่าขึ้นต้นด้วยคำว่า "เช็คแต้ม" ตามด้วยเบอร์โทรศัพท์ 9-10 หลักหรือไม่
    // (รองรับทั้งพิมพ์ติดกัน หรือเว้นวรรค เช่น "เช็คแต้ม0812345678" หรือ "เช็คแต้ม 0812345678")
    const match = userMessage.match(/^เช็คแต้ม\s*(\d{9,10})$/);

       if (match) {
      // 1. กรณีพิมพ์คำว่า "เช็คแต้ม" + เบอร์ถูกต้อง -> ไปดึงข้อมูลแต้มจาก Loyverse
      const phoneNumber = match[1];

      try {
        const response = await axios.get(LOYVERSE_API_URL, {
          headers: { 'Authorization': `Bearer ${process.env.LOYVERSE_TOKEN}` },
          params: { limit: 250 }
        });

        const customers = response.data.customers;
        let matchedCustomer = null;

        if (customers && customers.length > 0) {
          matchedCustomer = customers.find(c => {
            const phoneInSystem = c.phone_number ? c.phone_number.replace(/\s+/g, '') : '';
            return phoneInSystem === phoneNumber;
          });
        }

        if (matchedCustomer) {
          const points = matchedCustomer.total_points || 0;
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `สวัสดีครับ ${matchedCustomer.name}\nตอนนี้มีแต้มสะสมทั้งหมด: ${points} แต้มครับ ✨`
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
        console.error('Error fetching from Loyverse:', error);
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: 'เกิดข้อผิดพลาดในการดึงข้อมูลแต้ม กรุณาลองใหม่อีกครั้งในภายหลังครับ'
          }]
        });
      }

     } else {
      // 1.2 เช็คว่าเป็นกรณีพิมพ์เฉพาะคำว่า "#เช็คแต้ม" หรือ พิมพ์แค่เบอร์โทร 9-10 หลักโดดๆ
      const isCheckPointsKeyword = userMessage === '#เช็คแต้ม';
      const isOnlyPhoneNumber = /^\d{9,10}$/.test(userMessage);

      if (isCheckPointsKeyword || isOnlyPhoneNumber) {
        // ขึ้นข้อความสอนวิธีเช็คแต้ม
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: 'สวัสดีครับ 🐾 หากต้องการเช็คแต้มสะสม กรุณาพิมพ์คำว่า "เช็คแต้ม" ตามด้วยเบอร์โทรศัพท์ของคุณ เช่น เช็คแต้ม0812345678'
          }]
        });
      }
      // ถ้าพิมพ์อย่างอื่นเข้ามา (ไม่ใช่เบอร์โทร และไม่ได้พิมพ์เช็คแต้ม) -> ปล่อยผ่าน บอทจะไม่ตอบอะไรเลย
    }
  } // ปิด if (event.type === 'message' ...)
 // ปิด function handleEvent(event)

  return null;
}
//'สวัสดีครับ 🐾 หากต้องการเช็คแต้มสะสม กรุณาพิมพ์คำว่า "เช็คแต้ม" ตามด้วยเบอร์โทรศัพท์ของคุณได้เลยครับ เช่น เช็คแต้ม0832633238'

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
