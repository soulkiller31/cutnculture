import supabase from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

export const PaymentModel = {
  async createPending({ tenantId, orderId, plan, amount }) {
    const { data, error } = await supabase.from('payments').insert({
      tenant_id: tenantId,
      order_id: orderId,
      plan,
      amount,
      status: 'pending',
    }).select().single();
    if (error) throw new AppError(error.message || 'Failed to create payment record', 500);
    return data;
  },

  async findByOrderId(orderId) {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle();
    if (error) throw new AppError('Failed to fetch payment', 500);
    return data;
  },

  async markPaid(orderId, { paymentId, status = 'paid' } = {}) {
    const { data, error } = await supabase
      .from('payments')
      .update({ status, payment_id: paymentId || null, updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .select()
      .single();
    if (error) throw new AppError('Failed to update payment', 500);
    return data;
  },
};
