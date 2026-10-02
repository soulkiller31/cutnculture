import { SubscriptionModel, PLANS } from '../models/Subscription.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';

export const getPlans = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: Object.entries(PLANS)
      .filter(([key]) => key !== 'trial')
      .map(([key, val]) => ({ key, ...val })),
  });
});

export const createOrder = asyncHandler(async (_req, res) => {
  throw new AppError('Online payments are currently disabled. Please contact the salon directly.', 503);
});

export const verifyPayment = asyncHandler(async (_req, res) => {
  throw new AppError('Online payments are currently disabled.', 503);
});

export const webhook = asyncHandler(async (req, res) => {
  res.json({ success: true });
});
