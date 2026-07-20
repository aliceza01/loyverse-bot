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

// ฟังก์ชันจัดการข้อความที่ส่งมาจาก LINE
async function handleEvent(event) {
  // ตรวจสอบว่าต้องเป็นข้อความตัวหนังสือเท่านั้น
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

    const userMessage = event.message.text.trim();
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
