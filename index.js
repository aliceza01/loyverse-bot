require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const line = require('@line/bot-sdk');

const app = express();
const port = process.env.PORT || 3000;

// สร้าง endpoint เล็กๆ เพื่อให้ Render เช็ค status ได้
app.get('/', (req, res) => {
  res.send('Loyverse Daily Report Bot is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// ดึงค่า ID และตัดช่องว่างหัวท้ายออก
const targetId = (process.env.TARGET_USER_OR_GROUP_ID || '').trim();

// ตั้งค่า LINE Client
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim()
});

// ฟังก์ชันดึงยอดขายและกำไรจาก Loyverse API
async function getDailySales() {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    const response = await axios.get('https://api.loyverse.com/v1.0/receipts', {
      headers: {
        'Authorization': `Bearer ${(process.env.LOYVERSE_TOKEN || '').trim()}`
      },
      params: {
        created_at_min: startOfDay,
        created_at_max: endOfDay,
        limit: 250
      }
    });

    const receipts = response.data.receipts || [];
    let totalSales = 0;
    let totalCost = 0;
    let totalReceipts = receipts.length;

    receipts.forEach(receipt => {
      totalSales += receipt.total_money || 0;
      
      if (receipt.line_items) {
        receipt.line_items.forEach(item => {
          const itemCost = item.cost || 0;
          const quantity = item.quantity || 1;
          totalCost += (itemCost * quantity);
        });
      }
    });

    const netProfit = totalSales - totalCost;

    return {
      totalSales: totalSales.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      totalCost: totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      netProfit: netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      totalReceipts: totalReceipts
    };

  } catch (error) {
    console.error('Error fetching sales from Loyverse:', error.response ? error.response.data : error.message);
    return null;
  }
}

// ฟังก์ชันส่งรายงานเข้า LINE
async function sendDailyReport() {
  console.log('📊 กำลังดึงข้อมูลยอดขายและกำไรประจำวัน...');

  if (!targetId) {
    console.log('❌ กรุณาใส่ TARGET_USER_OR_GROUP_ID ใน Environment Variables');
    return;
  }

  const salesData = await getDailySales();

  if (!salesData) {
    console.log('❌ ไม่สามารถดึงข้อมูลยอดขายได้');
    return;
  }

  const todayStr = new Date().toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const messageText = `📈 สรุปยอดขาย & กำไรประจำวัน 📈\n📅 วันที่: ${todayStr}\n\n💵 ยอดขายรวม: ${salesData.totalSales} บาท\n💰 กำไรสุทธิ: ${salesData.netProfit} บาท\n🧾 จำนวนบิลทั้งหมด: ${salesData.totalReceipts} บิล\n\nขอบคุณสำหรับความตั้งใจทำงานในวันนี้ครับ! ✨`;

  try {
    await client.pushMessage({
      to: targetId,
      messages: [{
        type: 'text',
        text: messageText
      }]
    });
    console.log('✅ ส่งรายงานยอดขายและกำไรเข้า LINE เรียบร้อยแล้ว!');
  } catch (error) {
    console.error('❌ ไม่สามารถส่งข้อความเข้า LINE ได้:', error.response ? error.response.data : error.message);
  }
}

// ⏰ ตั้งเวลาทำงานอัตโนมัติด้วย Cron Job (ส่งทุกวัน เวลา 22:30 น. เวลาไทย)
cron.schedule('00 22 * * *', () => {
  console.log('⏰ ถึงเวลา 22:00 น. เริ่มรันระบบส่งรายงาน...');
  sendDailyReport();
}, {
  timezone: "Asia/Bangkok"
});

console.log('🚀 ระบบสรุปยอดขายอัตโนมัติบน Render ทำงานแล้ว...');


