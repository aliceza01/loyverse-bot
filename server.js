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

// ฟังก์ชันค้นหาข้อมูลลูกค้าใน Loyverse ด้วยเบอร์โทรศัพท์ (วนลูปตาม Cursor)
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
          'Authorization': `Bearer ${process.env.LOYVERSE_TOKEN}`,
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
      console.error("Error fetching from Loyverse:", error);
      break;
    }

  } while (cursor);

  return null;
}

// ฟังก์ชันสร้าง Flex Message แสดงของรางวัล
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
              {
                type: "text",
                text: "ส่วนลด 50 บาท",
                weight: "bold",
                size: "xl"
              },
              {
                type: "text",
                text: "ใช้ 50 แต้มสะสม",
                size: "sm",
                color: "#888888",
                margin: "md"
              }
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
                  text: "#แลกรางวัล 50 ส่วนลด 50"
                },
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
              {
                type: "text",
                text: "แก้วน้ำ Casper",
                weight: "bold",
                size: "xl"
              },
              {
                type: "text",
                text: "ใช้ 100 แต้มสะสม",
                size: "sm",
                color: "#888888",
                margin: "md"
              }
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
                  text: "#แลกรางวัล 100 แก้วน้ำ Casper"
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

// ฟังก์ชันหลักสำหรับจัดการข้อความที่ส่งมาจาก LINE
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();

  // 1. คำสั่งแสดงของรางวัล
  if (userMessage === "ของรางวัล" || userMessage === "#ของรางวัล") {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [getRewardFlexMessage()]
    });
  }

   // 2. คำสั่งเมื่อลูกค้ากดปุ่มแลกรางวัล
  if (userMessage.startsWith("#แลกรางวัล")) {
    // ตัดคำว่า #แลกรางวัล ออกแล้วลบช่องว่างหัวท้าย
    const rawContent = userMessage.replace("#แลกรางวัล", "").trim();
    
    // แยกแต้มกับชื่อของรางวัลด้วยช่องว่างแรกที่เจอ
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



  // 3. ตรวจสอบการพิมพ์คำว่า "เช็คแต้ม" + เบอร์โทรศัพท์
  const match = userMessage.match(/^เช็คแต้ม\s*(\d{9,10})$/);

  if (match) {
    const phoneNumber = match[1];

    try {
      const matchedCustomer = await findCustomerByPhone(phoneNumber);

      if (matchedCustomer) {
        const points = matchedCustomer.total_points || 0;
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `สวัสดีครับ ${matchedCustomer.name || 'ลูกค้า'}\nตอนนี้มีแต้มสะสมทั้งหมด: ${points} แต้มครับ ✨`
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

  // 4. กรณีพิมพ์เฉพาะคำว่า "#เช็คแต้ม" หรือ พิมพ์แค่เบอร์โทร 9-10 หลักโดดๆ
  const isCheckPointsKeyword = userMessage === '#เช็คแต้ม' || userMessage === 'เช็คแต้ม';
  const isOnlyPhoneNumber = /^\d{9,10}$/.test(userMessage);

  if (isCheckPointsKeyword || isOnlyPhoneNumber) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'สวัสดีครับ 🐾 หากต้องการเช็คแต้มสะสม กรุณาพิมพ์คำว่า "เช็คแต้ม" ตามด้วยเบอร์โทรศัพท์ของคุณ เช่น เช็คแต้ม0812345678'
      }]
    });
  }

  return Promise.resolve(null);
}

// เริ่มต้นเปิด Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


