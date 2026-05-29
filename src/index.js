require('dotenv').config();
const express = require('express');
const slackRoutes = require('./routes/slack');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use('/slack', slackRoutes);
app.use('/auth', authRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Listening on :${PORT}`));
