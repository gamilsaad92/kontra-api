app.get('/api/analytics/loan-portfolio', checkAuth, async (req, res) => {
  // e.g. counts by status
  const { data, error } = await supabase
    .from('loans')
    .select('status, count:count(*)')
    .group('status')
  if (error) return res.status(500).json({ message: 'Error' })
  res.json({ portfolio: data })
})
