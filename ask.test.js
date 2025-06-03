const request = require('supertest')
const app = require('../index') // export your express app from index.js

describe('POST /api/ask', () => {
  it('returns error if no question', async () => {
    const res = await request(app).post('/api/ask').send({})
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('Missing question')
  })
})
