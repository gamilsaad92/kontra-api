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
app.get('/', (req, res) => {
  res.send('Kontra API is running');
});

app.get('/api/test', (req, res) => {
  res.send('✅ API is alive');
});

// 📸 AI photo validation
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });

  const fileSizeKB = req.file.size / 1024;
  const result =
    fileSizeKB < 30
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

// 📥 Draw request submission
app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description } = req.body;

  if (!project || !amount || !description) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // 1. Get last draw for the project
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

  // 3. Submit new draw request
  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{
      project,
      amount,
      description,
      status: 'submitted',
      risk_score: riskScore,
      submitted_at: new Date().toISOString() // ✅ timestamp added here
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

// 🔄 Review/approve draw
app.post('/api/review-draw', async (req, res) => {
  const { id, status, comment } = req.body;

  if (!id || !status) {
    return res.status(400).json({ message: 'Missing id or status' });
  }

  const updates = {
    status,
    reviewedAt: new Date().toISOString(),
  };

  if (status === 'approved') updates.approvedAt = new Date().toISOString();
  if (status === 'rejected') {
    updates.rejectedAt = new Date().toISOString();
    updates.reviewComment = comment || '';
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

// 🗂️ Get all draws (for frontend)
app.get('/api/get-draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (error) {
    console.error('Get draws error:', error);
    return res.status(500).json({ message: 'Failed to fetch draw requests' });
  }

  res.json({ draws: data });
});

// 🔄 Add inspection for a draw
app.post('/api/add-inspection', async (req, res) => {
  const { draw_id, inspector, notes, photos } = req.body;

  if (!draw_id || !inspector) {
    return res.status(400).json({ message: 'Missing draw ID or inspector name' });
  }

  const { data, error } = await supabase
    .from('inspections')
    .insert([{ draw_id, inspector, notes, photos, created_at: new Date().toISOString() }])
    .select()
    .single();

  if (error) {
    console.error('Insert inspection error:', error);
    return res.status(500).json({ message: 'Failed to add inspection' });
  }

  res.status(200).json({ message: 'Inspection submitted', data });
});

// 🚀 Start server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Kontra API listening on port ${PORT}`);
});
