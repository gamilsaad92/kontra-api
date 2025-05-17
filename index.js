const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// 🔌 Connect to Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🌐 Health check
app.get('/', (req, res) => res.send('Kontra API is running'));
app.get('/api/test', (req, res) => res.send('✅ API is alive'));

// 📸 AI photo validation
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });
  const fileSizeKB = req.file.size / 1024;
  const result = fileSizeKB < 30
    ? 'Image too small — likely blurry ❌'
    : 'Image passed validation ✅';
  res.json({ result });
});

// 🧠 Risk Scoring Logic
function calculateRiskScore({ amount, description, lastSubmittedAt }) {
  let score = 100;
  if (amount > 100000) score -= 20;
  if (description.length < 15) score -= 10;
  if (lastSubmittedAt) {
    const lastDate = new Date(lastSubmittedAt);
    const now = new Date();
    const diffInDays = (now - lastDate) / (1000 * 60 * 60 * 24);
    if (diffInDays < 7) score -= 15;
  }
  return Math.max(score, 0);
}

// Stub for lien waiver AI verification
async function verifyLienWaiver(fileBuffer) {
  return { errors: [], fields: {} };
}

// 📥 Draw request submission
app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description, project_number, property_location } = req.body;
  if (!project || !amount || !description || !project_number || !property_location) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // 1. Fetch last draw timestamp
  const { data: lastDraw, error: lastDrawError } = await supabase
    .from('draw_requests')
    .select('submitted_at')
    .eq('project', project)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastDrawError) {
    console.error('Error fetching last draw:', lastDrawError);
    return res.status(500).json({ message: 'Error fetching previous draws' });
  }

  // 2. Calculate risk score
  const riskScore = calculateRiskScore({
    amount,
    description,
    lastSubmittedAt: lastDraw?.submitted_at
  });

  // 3. Insert new draw request
  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{
      project,
      amount,
      description,
      project_number,
      property_location,
      status: 'submitted',
      risk_score: riskScore,
      submitted_at: new Date().toISOString()
    }])
    .select()
    .single();
  if (error) {
    console.error('Insert error:', error);
    return res.status(500).json({ message: 'Failed to submit draw request' });
  }

  console.log('📥 Submitted draw with risk score:', data.risk_score);
  res.status(200).json({ message: 'Draw request submitted!', data });
});

// 🔄 Review / approve draw
app.post('/api/review-draw', async (req, res) => {
  const { id, status, comment } = req.body;
  if (!id || !status) return res.status(400).json({ message: 'Missing id or status' });

  const updates = { status, reviewed_at: new Date().toISOString() };
  if (status === 'approved') updates.approved_at = new Date().toISOString();
  if (status === 'rejected') {
    updates.rejected_at = new Date().toISOString();
    updates.review_comment = comment || '';
  }

  const { data, error } = await supabase
    .from('draw_requests')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.error('Update error:', error);
    return res.status(500).json({ message: 'Failed to update draw request' });
  }

  console.log('🔄 Updated draw request:', data);
  res.status(200).json({ message: 'Draw request updated', data });
});

// 🗂️ Get all draws including aliased fields
app.get('/api/get-draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select(`
      id,
      project,
      amount,
      description,
      project_number,
      property_location,
      status,
      submitted_at    as submittedAt,
      reviewed_at     as reviewedAt,
      approved_at     as approvedAt,
      rejected_at     as rejectedAt,
      review_comment  as reviewComment,
      risk_score      as riskScore
    `)
    .order('submitted_at', { ascending: false });
  if (error) {
    console.error('Get draws error:', error);
    return res.status(500).json({ message: 'Failed to fetch draw requests' });
  }
  res.json({ draws: data });
});

// 📁 Upload and verify lien waiver
app.post('/api/upload-lien-waiver', upload.single('file'), async (req, res) => {
  const { draw_id, contractor_name, waiver_type } = req.body;
  if (!draw_id || !contractor_name || !waiver_type || !req.file) {
    return res.status(400).json({ message: 'Missing required fields or file' });
  }

  // 1. Save file to Supabase Storage
  const filePath = `lien-waivers/${draw_id}/${Date.now()}_${req.file.originalname}`;
  const { error: uploadError } = await supabase
    .storage
    .from('draw-inspections')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) {
    console.error('Storage upload error:', uploadError);
    return res.status(500).json({ message: 'File upload failed' });
  }
  const fileUrl = supabase
    .storage
    .from('draw-inspections')
    .getPublicUrl(filePath)
    .publicURL;

  // 2. AI verification stub
  const aiReport = await verifyLienWaiver(req.file.buffer);
  const passed = aiReport.errors.length === 0;

  // 3. Insert record
  const { data, error } = await supabase
    .from('lien_waivers')
    .insert([{
      draw_id: parseInt(draw_id, 10),
      contractor_name,
      waiver_type,
      file_url: fileUrl,
      verified_at: new Date().toISOString(),
      verification_passed: passed,
      verification_report: aiReport
    }])
    .select()
    .single();
  if (error) {
    console.error('Insert lien waiver error:', error);
    return res.status(500).json({ message: 'Failed to save waiver' });
  }

  res.status(200).json({ message: 'Lien waiver uploaded', data });
});

// 🚀 Start server
const PORT = process.env.PORT || 5050;
// ─── List lien waivers by draw ───────────────────────────
app.get('/api/list-lien-waivers', async (req, res) => {
  const { draw_id } = req.query;
  if (!draw_id) return res.status(400).json({ message: 'Missing draw_id' });

  const { data, error } = await supabase
    .from('lien_waivers')
    .select('id, contractor_name, waiver_type, file_url, verified_at, verification_passed')
    .eq('draw_id', draw_id)
    .order('verified_at', { ascending: false });

  if (error) return res.status(500).json({ message: 'Failed to list waivers' });
  res.json({ waivers: data });
});
app.post('/api/loans', async (req, res) => {
  const { borrower_name, amount, interest_rate, term_months, start_date } = req.body;
  if (!borrower_name || !amount || !interest_rate || !term_months || !start_date) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  const { data, error } = await supabase
    .from('loans')
    .insert([{ borrower_name, amount, interest_rate, term_months, start_date }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to create loan' });
  res.status(201).json({ loan: data });
});

// 2) List loans
app.get('/api/loans', async (req, res) => {
  const { data, error } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, interest_rate, term_months, start_date, status, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to fetch loans' });
  res.json({ loans: data });
});
2.1 Generate amortization schedule (call once per loan)
app.post('/api/loans/:loanId/generate-schedule', async (req, res) => {
  const { loanId } = req.params;
  // Fetch loan terms
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount, interest_rate, term_months, start_date')
    .eq('id', loanId)
    .single();
  if (loanErr || !loan) return res.status(404).json({ message: 'Loan not found' });

  const P = parseFloat(loan.amount);
  const r = parseFloat(loan.interest_rate) / 100 / 12; // monthly rate
  const n = parseInt(loan.term_months, 10);
  // Monthly payment formula: A = P * r/(1 - (1+r)^-n)
  const A = P * r / (1 - Math.pow(1 + r, -n));

  const inserts = [];
  let balance = P;
  let date = new Date(loan.start_date);
  for (let i = 1; i <= n; i++) {
    const interestDue = balance * r;
    const principalDue = A - interestDue;
    balance = balance - principalDue;
    inserts.push({ loan_id: loanId, due_date: date.toISOString().slice(0,10), principal_due: principalDue, interest_due: interestDue, balance_after: balance });
    // next month
    date.setMonth(date.getMonth() + 1);
  }

  const { data, error } = await supabase
    .from('amortization_schedules')
    .insert(inserts)
    .select();
  if (error) return res.status(500).json({ message: 'Failed to generate schedule' });
  res.json({ schedule: data });
});

// 2.2 List schedule
app.get('/api/loans/:loanId/schedule', async (req, res) => {
  const { data, error } = await supabase
    .from('amortization_schedules')
    .select('*')
    .eq('loan_id', req.params.loanId)
    .order('due_date', { ascending: true });
  if (error) return res.status(500).json({ message: 'Failed to fetch schedule' });
  res.json({ schedule: data });
});

// 2.3 Record a payment
app.post('/api/loans/:loanId/payments', async (req, res) => {
  const { amount, payment_date } = req.body;
  const { data: lastPayment, error: lastErr } = await supabase
    .from('payments')
    .select('remaining_balance')
    .eq('loan_id', req.params.loanId)
    .order('payment_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) return res.status(500).json({ message: 'Failed to fetch last payment' });

  const prevBalance = lastPayment ? parseFloat(lastPayment.remaining_balance) : null;
  // If no previous payment, fetch initial loan amount
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount')
    .eq('id', req.params.loanId)
    .single();
  if (!loan) return res.status(404).json({ message: 'Loan not found' });
  let balance = prevBalance !== null ? prevBalance : parseFloat(loan.amount);

  // Assuming full payment applies interest first at current rate
  // Fetch loan rate
  const { data: loan2 } = await supabase
    .from('loans')
    .select('interest_rate')
    .eq('id', req.params.loanId)
    .single();
  const r = parseFloat(loan2.interest_rate) / 100 / 12;
  const interest = balance * r;
  const principal = Math.max(0, amount - interest);
  const remaining = balance - principal;

  const { data, error } = await supabase
    .from('payments')
    .insert([{ loan_id: parseInt(req.params.loanId,10), payment_date, amount, applied_principal: principal, applied_interest: interest, remaining_balance: remaining }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to record payment' });
  res.status(201).json({ payment: data });
});

app.listen(PORT, () => console.log(`Kontra API listening on port ${PORT}`));
