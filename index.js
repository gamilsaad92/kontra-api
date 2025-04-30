const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.get('/', (req, res) => {
  res.send('Kontra API is running');
});

app.get('/api/test', (req, res) => {
  res.send('✅ API is alive');
});

app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });

  const fileSizeKB = req.file.size / 1024;
  const result = fileSizeKB < 30
    ? 'Image too small — likely blurry ❌'
    : 'Image passed validation ✅';

  res.json({ result });
});

app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description } = req.body;

  if (!project || !amount || !description) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{ project, amount, description, status: 'submitted' }]);

  if (error) {
    console.error('Insert error:', error);
    return res.status(500).json({ message: 'Failed to submit draw request' });
  }

  res.status(200).json({ message: 'Draw request submitted!', data });
});

app.post('/api/review-draw', async (req, res) => {
  const { id, status, comment } = req.body;

  if (!id || !status) {
    return res.status(400).json({ message: 'Missing id or status' });
  }

  const updates = {
    status,
    reviewedAt: new Date().toISOString(),
  };

  if (status === 'approved') {
    updates.approvedAt = new Date().toISOString();
  }

  if (status === 'rejected') {
    updates.rejectedAt = new Date().toISOString();
    updates.reviewComment = comment || '';
  }

  const { data, error } = await supabase
    .from('draw_requests')
    .update(updates)
    .eq('id', id);

  if (error) {
    console.error('Update error:', error);
    return res.status(500).json({ message: 'Failed to update draw request' });
  }

  res.status(200).json({ message: 'Draw request updated', data });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Kontra API listening on port ${PORT}`);
});
