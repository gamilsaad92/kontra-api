// worker.js
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// This runs hourly (or daily)—configure in Render Cron
async function checkAlerts() {
  // 1) Draws awaiting review > 24h
  const { data: pendingDraws } = await supabase
    .from('draw_requests')
    .select('id, created_at, project_id')
    .eq('status', 'submitted')
    .lte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())

  for (const draw of pendingDraws) {
    // e.g., insert a row in `notifications` table
    await supabase.from('notifications').insert([{
      user_id: '<LenderUserId>', // you can look up which lender is assigned to project_id
      message: `Draw #${draw.id} has been pending review for over 24h.`,
      link: `/draws/${draw.id}`,
    }])
  }

  // 2) Overdue lien waivers (e.g., none uploaded within 7 days of draw)
  const { data: drawsPastDue } = await supabase
    .from('draw_requests')
    .select('id, project_id, submitted_at')
    .eq('status', 'approved')
    .lte('submitted_at', new Date(Date.now() - 7*24*60*60*1000).toISOString())

  for (const draw of drawsPastDue) {
    const { data: waivers } = await supabase
      .from('lien_waivers')
      .select('id')
      .eq('draw_id', draw.id)

    if (waivers.length === 0) {
      await supabase.from('notifications').insert([{
        user_id: '<ContractorUserId>',
        message: `No lien waiver uploaded for Draw #${draw.id} in Project ${draw.project_id}.`,
        link: `/draws/${draw.id}`,
      }])
    }
  }

  // 3) Overdue payments (loans with scheduled payment past due date)
  const { data: overduePayments } = await supabase
    .from('amortization_schedules')
    .select('loan_id, due_date')
    .lte('due_date', new Date().toISOString())
    .not('paid', 'eq', true)

  for (const o of overduePayments) {
    await supabase.from('notifications').insert([{
      user_id: '<BorrowerUserId>',
      message: `Payment for Loan #${o.loan_id} was due on ${o.due_date}. Please pay now.`,
      link: `/loans/${o.loan_id}`,
    }])
  }

  console.log('✅ Alert check finished')
}

checkAlerts().then(() => process.exit()).catch(console.error)
