import dotenv from 'dotenv';
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'FRONTEND_URL',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'ADMIN_NAME',
];

for (const key of required) {
  const value = process.env[key];
  const isPlaceholder = value && /^(replace-with|REPLACE_ON_VPS)/.test(value);
  if (!value || isPlaceholder) {
    const message = `Missing or placeholder environment variable: ${key}`;
    if (isProduction) throw new Error(message);
    console.warn(`Warning: ${message}`);
  }
}

if (isProduction && process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

export default {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv,
  autoInitWhatsApp: process.env.AUTO_INIT_WHATSAPP
    ? process.env.AUTO_INIT_WHATSAPP === 'true'
    : (process.env.NODE_ENV || 'development') === 'production',
  whatsappReconnectDelayMs: parseInt(process.env.WHATSAPP_RECONNECT_DELAY_MS, 10) || 30000,
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  frontendUrls: (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  salonName: process.env.SALON_NAME || 'Your Business',
  salonAddress: process.env.SALON_ADDRESS || '',
  salonPhone: process.env.SALON_PHONE || '',
  whatsappSessionPath: process.env.WHATSAPP_SESSION_PATH || './.wwebjs_auth',
  cronTimezone: process.env.CRON_TIMEZONE || 'Asia/Kolkata',
  backendUrl: process.env.BACKEND_URL || process.env.FRONTEND_URL || 'http://localhost:5000',
  admin: {
    email: process.env.ADMIN_EMAIL || (isProduction ? undefined : 'admin@salon.com'),
    password: process.env.ADMIN_PASSWORD || (isProduction ? undefined : 'Admin@123456'),
    name: process.env.ADMIN_NAME || (isProduction ? undefined : 'Salon Admin'),
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY || '',
  },
};
