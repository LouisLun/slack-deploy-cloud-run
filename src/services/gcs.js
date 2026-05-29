const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

async function readConfig() {
  const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
  const file = bucket.file(process.env.GCS_CONFIG_FILE_PATH);
  const [content] = await file.download();
  return JSON.parse(content.toString('utf-8'));
}

module.exports = { readConfig };
