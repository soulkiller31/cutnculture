import { InvoiceModel } from '../models/Invoice.js';
import { CustomerModel } from '../models/Customer.js';
import { MessageLogModel } from '../models/MessageLog.js';
import { SettingsModel } from '../models/WhatsApp.js';
import { getWhatsAppService } from '../services/whatsappService.js';
import { generateInvoicePdf } from '../services/invoicePdfService.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireTenantId, brandingFromTenant } from '../utils/tenant.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const normalizeGender = (gender) => {
  if (gender === undefined) return undefined;
  if (gender === null || gender === '') return null;
  return String(gender).trim().toLowerCase();
};

const calcTotals = (items, discount = 0, taxRate = 0) => {
  const subtotal = items.reduce((sum, item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    return sum + qty * price;
  }, 0);
  const discountAmt = Number(discount) || 0;
  const taxable = Math.max(subtotal - discountAmt, 0);
  const tax = taxRate ? (taxable * Number(taxRate)) / 100 : 0;
  const total = taxable + tax;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discountAmt * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
};

const formatInvoiceMessage = (invoice, salonName, salonAddress, salonPhone) => {
  const customerName = invoice.customer_name || 'Valued Customer';
  const invoiceDate = new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const invoiceNo = String(invoice.invoice_number).padStart(4, '0');

  const lines = [
    `Hello ${customerName}! 🙏`,
    '',
    `Thank you for visiting *${salonName}* today!`,
    'We are delighted to serve you. Please find your invoice details below:',
    '',
    '━━━━━━━━━━━━━━━━',
    `*INVOICE #${invoiceNo}*`,
    `Date: ${invoiceDate}`,
    '━━━━━━━━━━━━━━━━',
    '',
    '*Bill To:*',
    customerName,
    `Phone: ${invoice.customer_phone}`,
  ];

  if (invoice.customer_address) lines.push(`Address: ${invoice.customer_address}`);
  lines.push('', '*Services / Items:*');

  (invoice.items || []).forEach((item) => {
    const qty = Number(item.quantity) || 1;
    const price = Number(item.price) || 0;
    lines.push(`• ${item.description}  ×${qty}  —  ₹${(qty * price).toFixed(2)}`);
  });

  lines.push(
    '',
    `Subtotal: ₹${Number(invoice.subtotal).toFixed(2)}`,
  );

  if (Number(invoice.discount) > 0) {
    lines.push(`Discount: -₹${Number(invoice.discount).toFixed(2)}`);
  }
  if (Number(invoice.tax) > 0) {
    lines.push(`Tax: ₹${Number(invoice.tax).toFixed(2)}`);
  }

  lines.push(
    '',
    `*Grand Total: ₹${Number(invoice.total).toFixed(2)}*`,
    '',
    `🌟 *Thank you so much for choosing ${salonName}!*`,
    'We hope you had a wonderful experience with us.',
    'We look forward to welcoming you again soon!',
    '',
    'With warm regards,',
    `*${salonName}*`,
  );

  if (salonAddress) lines.push(salonAddress);
  if (salonPhone) lines.push(`📞 ${salonPhone}`);

  if (invoice.notes) {
    lines.push('', `_Note: ${invoice.notes}_`);
  }

  return lines.join('\n');
};

const resolveBranding = async (req) => {
  const tenantId = requireTenantId(req);
  const fallback = brandingFromTenant(req.tenant);
  const name = await SettingsModel.getString('salon_name', fallback.name, tenantId);
  const address = await SettingsModel.getString('salon_address', fallback.address, tenantId);
  const phone = await SettingsModel.getString('salon_phone', fallback.phone, tenantId);
  const gstin = await SettingsModel.getString('salon_gstin', fallback.gstin, tenantId);
  const logoUrl = await SettingsModel.getString('salon_logo', fallback.logoUrl, tenantId);
  return { tenantId, name, address, phone, gstin, logoUrl };
};

export const getNextInvoiceNumber = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const nextNumber = await InvoiceModel.getNextNumber(tenantId);
  res.json({ success: true, data: { invoice_number: nextNumber } });
});

export const getInvoices = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const { page, limit } = req.query;
  const result = await InvoiceModel.findAll({
    tenantId,
    page: parseInt(page, 10) || 1,
    limit: parseInt(limit, 10) || 20,
  });
  res.json({ success: true, data: result });
});

export const getInvoice = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const invoice = await InvoiceModel.findById(req.params.id, tenantId);
  res.json({ success: true, data: invoice });
});

export const saveCustomerAndSendWhatsApp = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const {
    customer: customerData,
    items = [],
    discount = 0,
    tax_rate = 0,
    notes,
    payment_method = 'cash',
    cash_amount = null,
    online_amount = null,
    send_whatsapp = true,
  } = req.body;

  if (!customerData?.name?.trim() || !customerData?.phone?.trim()) {
    throw new AppError('Customer name and phone are required', 400);
  }

  if (!items.length) {
    throw new AppError('At least one invoice item is required', 400);
  }

  let customer = await CustomerModel.findByPhone(customerData.phone, tenantId);
  const customerPayload = {
    tenant_id: tenantId,
    name: customerData.name.trim(),
    phone: customerData.phone.trim(),
    email: customerData.email || null,
    address: customerData.address || null,
    birthday: customerData.birthday || null,
    anniversary: customerData.anniversary || null,
    last_visit: customerData.last_visit || new Date().toISOString().split('T')[0],
    gender: normalizeGender(customerData.gender),
    notes: customerData.notes || null,
    is_active: customerData.is_active ?? true,
  };
  if (customerData.gstin) customerPayload.gstin = customerData.gstin;

  if (customer) {
    customer = await CustomerModel.update(customer.id, customerPayload, tenantId);
  } else {
    customer = await CustomerModel.create(customerPayload);
  }

  const totals = calcTotals(items, discount, tax_rate);
  const invoiceNumber = await InvoiceModel.getNextNumber(tenantId);
  const invoice = await InvoiceModel.create({
    tenant_id: tenantId,
    invoice_number: invoiceNumber,
    customer_id: customer.id,
    customer_name: customer.name,
    customer_phone: customer.phone,
    customer_email: customer.email,
    customer_address: customer.address,
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    notes: notes || null,
    payment_method: ['cash', 'online', 'split'].includes(payment_method) ? payment_method : 'cash',
    cash_amount: payment_method === 'split' ? (Math.round(Number(cash_amount) * 100) / 100 || 0) : null,
    online_amount: payment_method === 'split' ? (Math.round(Number(online_amount) * 100) / 100 || 0) : null,
    whatsapp_sent: false,
  });

  let whatsappResult = null;

  if (send_whatsapp) {
    const svc = getWhatsAppService(tenantId);
    await svc.initialize();
    const statusBefore = svc.getStatus();
    if (!statusBefore.isConnected) {
      let waited = 0;
      const pollEvery = 500;
      const pollTimeout = 10000;
      while (!svc.getStatus().isConnected && waited < pollTimeout) {
        await new Promise((r) => setTimeout(r, pollEvery));
        waited += pollEvery;
      }
    }
    if (!svc.getStatus().isConnected) {
      const st = svc.getStatus();
      const detail = st.status === 'qr_ready'
        ? 'WhatsApp QR not scanned yet. Invoice saved — will auto-send when WhatsApp connects.'
        : st.status === 'initializing'
          ? 'WhatsApp still connecting. Invoice saved — will auto-send when ready.'
          : `WhatsApp not connected (${st.status}). Invoice saved — will auto-send when WhatsApp is back online.`;
      res.status(201).json({
        success: true,
        message: detail,
        data: {
          customer,
          invoice,
          next_invoice_number: await InvoiceModel.getNextNumber(tenantId),
          whatsapp: { sent: false, deferred: true, status: st.status },
        },
      });
      return;
    }

    const branding = await resolveBranding(req);
    const salonName = branding.name;
    const salonAddress = branding.address;
    const salonPhone = branding.phone;
    const salonGstin = branding.gstin;
    const salonLogo = branding.logoUrl;

    // Generate PDF invoice
    let tmpPdfPath = null;
    try {
      const pdfBuffer = await generateInvoicePdf(invoice, salonName, salonAddress, salonPhone, salonGstin, salonLogo);
      tmpPdfPath = path.join(os.tmpdir(), `invoice-${invoice.invoice_number}-${Date.now()}.pdf`);
      fs.writeFileSync(tmpPdfPath, pdfBuffer);
      console.log(`[Invoice] PDF generated: ${tmpPdfPath} (${pdfBuffer.length} bytes)`);
    } catch (pdfErr) {
      console.warn('[Invoice] PDF generation failed:', pdfErr.message);
      throw new AppError(`Invoice saved but PDF generation failed: ${pdfErr.message}`, 500);
    }

    const invoiceNo = String(invoice.invoice_number).padStart(4, '0');
    const caption = `Hello ${invoice.customer_name}! 🙏\n\nPlease find your invoice *#${invoiceNo}* from *${salonName}* attached.\n\n*Total: ₹${Number(invoice.total).toFixed(2)}*\n\nThank you for visiting us! 🌟`;
    const filename = `Invoice-${invoiceNo}.pdf`;
    const textMessage = formatInvoiceMessage(invoice, salonName, salonAddress, salonPhone);

    let sentMethod = null;
    let sendError = null;

    // Try PDF first, fall back to text message if media sending fails
    try {
      await svc.sendDocument(customer.phone, tmpPdfPath, filename, caption);
      console.log('[Invoice] PDF sent to', customer.phone);
      sentMethod = 'pdf';
    } catch (pdfSendErr) {
      console.warn(`[Invoice] PDF send failed (${pdfSendErr.message.split('\n')[0]}), falling back to text message…`);
      try {
        await svc.sendMessage(customer.phone, textMessage);
        console.log('[Invoice] Text invoice sent to', customer.phone);
        sentMethod = 'text';
      } catch (textSendErr) {
        console.error('[Invoice] Text fallback also failed:', textSendErr.message);
        sendError = textSendErr;
      }
    } finally {
      if (tmpPdfPath) { try { fs.unlinkSync(tmpPdfPath); } catch { /* ignore */ } }
    }

    if (sentMethod) {
      await MessageLogModel.create({
        tenant_id: tenantId,
        customer_id: customer.id,
        phone: customer.phone,
        message: sentMethod === 'pdf' ? caption : textMessage,
        type: 'invoice',
        status: 'sent',
      });
      await InvoiceModel.markWhatsAppSent(invoice.id, tenantId);
      whatsappResult = { sent: true, method: sentMethod };
    } else {
      await MessageLogModel.create({
        tenant_id: tenantId,
        customer_id: customer.id,
        phone: customer.phone,
        message: caption,
        type: 'invoice',
        status: 'failed',
        error_message: sendError?.message,
      });
      throw new AppError(`Invoice saved but WhatsApp send failed: ${sendError?.message}`, 500);
    }
  }

  const nextNumber = await InvoiceModel.getNextNumber(tenantId);

  res.status(201).json({
    success: true,
    message: whatsappResult?.sent
      ? 'Customer saved, invoice created, and WhatsApp sent'
      : 'Customer saved and invoice created',
    data: {
      customer,
      invoice,
      next_invoice_number: nextNumber,
      whatsapp: whatsappResult,
    },
  });
});

export const downloadInvoicePdf = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const invoice = await InvoiceModel.findById(req.params.id, tenantId);
  const branding = await resolveBranding(req);

  const pdfBuffer = await generateInvoicePdf(invoice, branding.name, branding.address, branding.phone, branding.gstin, branding.logoUrl);

  const invoiceNo = String(invoice.invoice_number).padStart(4, '0');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoiceNo}.pdf"`);
  res.send(pdfBuffer);
});

export const resendInvoicePdf = asyncHandler(async (req, res) => {
  const tenantId = requireTenantId(req);
  const invoice = await InvoiceModel.findById(req.params.id, tenantId);

  // Use provided phone or fall back to original customer phone
  const phone = (req.body.phone || invoice.customer_phone || '').trim();
  if (!phone) throw new AppError('Phone number is required', 400);

  const svcResend = getWhatsAppService(tenantId);
  await svcResend.initialize();
  if (!svcResend.getStatus().isConnected) {
    let waited = 0;
    while (!svcResend.getStatus().isConnected && waited < 8000) {
      await new Promise((r) => setTimeout(r, 500));
      waited += 500;
    }
  }
  if (!svcResend.getStatus().isConnected) {
    const st = svcResend.getStatus();
    throw new AppError(`WhatsApp not connected (${st.status}). Please open the WhatsApp page and scan QR first.`, 400);
  }

  const branding = await resolveBranding(req);
  const pdfBuffer = await generateInvoicePdf(invoice, branding.name, branding.address, branding.phone, branding.gstin, branding.logoUrl);
  const invoiceNo = String(invoice.invoice_number).padStart(4, '0');
  const tmpPdfPath = path.join(os.tmpdir(), `invoice-resend-${invoice.invoice_number}-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdfPath, pdfBuffer);

  const caption = `Hello! 🙏\n\nPlease find invoice *#${invoiceNo}* from *${branding.name}* attached.\n\n*Total: ₹${Number(invoice.total).toFixed(2)}*\n\nThank you! 🌟`;
  const filename = `Invoice-${invoiceNo}.pdf`;
  const textMessage = formatInvoiceMessage(invoice, branding.name, branding.address, branding.phone);

  let sentMethod = null;
  let sendError = null;

  try {
    await svcResend.sendDocument(phone, tmpPdfPath, filename, caption);
    sentMethod = 'pdf';
  } catch (pdfErr) {
    console.warn(`[Invoice] Resend PDF failed (${pdfErr.message.split('\n')[0]}), trying text…`);
    try {
      await svcResend.sendMessage(phone, textMessage);
      sentMethod = 'text';
    } catch (textErr) {
      sendError = textErr;
    }
  } finally {
    try { fs.unlinkSync(tmpPdfPath); } catch { /* ignore */ }
  }

  if (sentMethod) {
    await MessageLogModel.create({
      tenant_id: tenantId,
      customer_id: invoice.customer_id,
      phone,
      message: sentMethod === 'pdf' ? caption : textMessage,
      type: 'invoice',
      status: 'sent',
    });
    res.json({ success: true, message: `Invoice #${invoiceNo} resent to ${phone} (${sentMethod})` });
  } else {
    await MessageLogModel.create({
      tenant_id: tenantId,
      customer_id: invoice.customer_id,
      phone,
      message: caption,
      type: 'invoice',
      status: 'failed',
      error_message: sendError?.message,
    });
    throw new AppError(`Resend failed: ${sendError?.message}`, 500);
  }
});

export const getInvoiceReport = asyncHandler(async (req, res) => {
  const { filter = 'month', start, end } = req.query;

  const VALID = ['today', 'month', 'all', 'custom'];
  if (!VALID.includes(filter)) {
    throw new AppError(`Invalid filter "${filter}". Must be one of: ${VALID.join(', ')}`, 400);
  }

  if (filter === 'custom' && (!start || !end)) {
    throw new AppError('start and end query params are required when filter=custom', 400);
  }

  const rows = await InvoiceModel.getReport({ tenantId: requireTenantId(req), filter, start, end });
  res.json({ success: true, data: rows });
});

export const exportVisitReport = asyncHandler(async (req, res) => {
  const { filter = 'month', start, end } = req.query;

  const VALID = ['today', 'month', 'all', 'custom'];
  if (!VALID.includes(filter)) throw new AppError(`Invalid filter "${filter}"`, 400);
  if (filter === 'custom' && (!start || !end)) throw new AppError('start and end required when filter=custom', 400);

  const rows = await InvoiceModel.getReport({ tenantId: requireTenantId(req), filter, start, end });

  // Build Excel using xlsx (already installed)
  const { utils, write } = await import('xlsx');

  const wsData = [
    ['S.No', 'Customer Name', 'Phone', 'DOB', 'Anniversary', 'Services', 'Amount (Rs.)', 'Payment', 'Visit Date'],
    ...rows.map((row, i) => [
      i + 1,
      row.customer_name,
      row.customer_phone,
      row.birthday || '',
      row.anniversary || '',
      (row.items || []).map(item => item.description).join(', '),
      Number(row.total),
      row.payment_method || 'cash',
      new Date(row.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    ]),
  ];

  const ws = utils.aoa_to_sheet(wsData);
  ws['!cols'] = [
    { wch: 6 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 40 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
  ];

  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Visit Report');

  const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });
  const dateStr = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="visit-report-${dateStr}.xlsx"`);
  res.send(buf);
});

export const getBusinessReport = asyncHandler(async (req, res) => {
  const { filter = 'month', start, end } = req.query;

  const VALID = ['today', 'month', 'all', 'custom'];
  if (!VALID.includes(filter)) throw new AppError(`Invalid filter "${filter}"`, 400);
  if (filter === 'custom' && (!start || !end)) throw new AppError('start and end required when filter=custom', 400);

  const rows = await InvoiceModel.getReport({ tenantId: requireTenantId(req), filter, start, end });

  // Payment method breakdown — correctly handles split payments
  let cashRevenue = 0, onlineRevenue = 0, cashCount = 0, onlineCount = 0, splitCount = 0;
  rows.forEach(r => {
    const total = Number(r.total);
    if (r.payment_method === 'online') {
      onlineRevenue += total;
      onlineCount++;
    } else if (r.payment_method === 'split') {
      cashRevenue += Number(r.cash_amount) || 0;
      onlineRevenue += Number(r.online_amount) || 0;
      splitCount++;
    } else {
      cashRevenue += total;
      cashCount++;
    }
  });

  // Total revenue and visits
  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.total), 0);
  const totalVisits = rows.length;
  const avgPerVisit = totalVisits > 0 ? totalRevenue / totalVisits : 0;

  // Unique customers
  const uniqueCustomers = new Set(rows.map(r => r.customer_phone)).size;

  // Top services — count how many times each service appears
  const serviceCount = {};
  rows.forEach(row => {
    (row.items || []).forEach(item => {
      const name = item.description || 'Unknown';
      serviceCount[name] = (serviceCount[name] || 0) + 1;
    });
  });
  const topServices = Object.entries(serviceCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Top customers by revenue
  const customerRevenue = {};
  const customerVisits = {};
  rows.forEach(row => {
    const key = row.customer_phone;
    customerRevenue[key] = (customerRevenue[key] || 0) + Number(row.total);
    customerVisits[key] = (customerVisits[key] || 0) + 1;
    // Store name alongside phone
    if (!customerRevenue[`${key}_name`]) customerRevenue[`${key}_name`] = row.customer_name;
  });
  const topCustomers = Object.entries(customerRevenue)
    .filter(([key]) => !key.endsWith('_name'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phone, revenue]) => ({
      name: customerRevenue[`${phone}_name`] || phone,
      phone,
      revenue: Math.round(revenue * 100) / 100,
      visits: customerVisits[phone] || 0,
    }));

  // Daily revenue breakdown (for charts — group by date)
  const dailyRevenue = {};
  rows.forEach(row => {
    const date = row.created_at.split('T')[0];
    dailyRevenue[date] = (dailyRevenue[date] || 0) + Number(row.total);
  });
  const dailyBreakdown = Object.entries(dailyRevenue)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, revenue]) => ({
      date,
      revenue: Math.round(revenue * 100) / 100,
      label: new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    }));

  res.json({
    success: true,
    data: {
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalVisits,
        uniqueCustomers,
        avgPerVisit: Math.round(avgPerVisit * 100) / 100,
        cashRevenue: Math.round(cashRevenue * 100) / 100,
        onlineRevenue: Math.round(onlineRevenue * 100) / 100,
        cashCount,
        onlineCount,
        splitCount,
      },
      topServices,
      topCustomers,
      dailyBreakdown,
    },
  });
});

export const exportBusinessReport = asyncHandler(async (req, res) => {
  const { filter = 'month', start, end } = req.query;

  const VALID = ['today', 'month', 'all', 'custom'];
  if (!VALID.includes(filter)) throw new AppError(`Invalid filter "${filter}"`, 400);
  if (filter === 'custom' && (!start || !end)) throw new AppError('start and end required when filter=custom', 400);

  const rows = await InvoiceModel.getReport({ tenantId: requireTenantId(req), filter, start, end });
  const { utils, write } = await import('xlsx');

  // Sheet 1: Summary
  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.total), 0);
  const totalVisits = rows.length;
  const uniqueCustomers = new Set(rows.map(r => r.customer_phone)).size;
  const avgPerVisit = totalVisits > 0 ? totalRevenue / totalVisits : 0;

  const summaryData = [
    ['Metric', 'Value'],
    ['Total Revenue (Rs.)', Math.round(totalRevenue * 100) / 100],
    ['Total Visits', totalVisits],
    ['Unique Customers', uniqueCustomers],
    ['Avg per Visit (Rs.)', Math.round(avgPerVisit * 100) / 100],
    ['Cash Revenue (Rs.)', (() => {
      let c = 0;
      rows.forEach(r => {
        if (r.payment_method === 'split') c += Number(r.cash_amount) || 0;
        else if (r.payment_method !== 'online') c += Number(r.total);
      });
      return Math.round(c * 100) / 100;
    })()],
    ['Online Revenue (Rs.)', (() => {
      let o = 0;
      rows.forEach(r => {
        if (r.payment_method === 'split') o += Number(r.online_amount) || 0;
        else if (r.payment_method === 'online') o += Number(r.total);
      });
      return Math.round(o * 100) / 100;
    })()],
    ['Cash Payments', rows.filter(r => r.payment_method === 'cash').length],
    ['Online Payments', rows.filter(r => r.payment_method === 'online').length],
    ['Split Payments', rows.filter(r => r.payment_method === 'split').length],
    ['Period', filter === 'custom' ? `${start} to ${end}` : filter],
    ['Generated On', new Date().toLocaleDateString('en-IN')],
  ];

  // Sheet 2: Top Services
  const serviceCount = {};
  rows.forEach(row => {
    (row.items || []).forEach(item => {
      const name = item.description || 'Unknown';
      serviceCount[name] = (serviceCount[name] || 0) + 1;
    });
  });
  const topServices = Object.entries(serviceCount).sort((a, b) => b[1] - a[1]);
  const servicesData = [
    ['Service Name', 'Count'],
    ...topServices.map(([name, count]) => [name, count]),
  ];

  // Sheet 3: Top Customers
  const customerRevenue = {};
  const customerVisits = {};
  rows.forEach(row => {
    const key = row.customer_phone;
    customerRevenue[key] = (customerRevenue[key] || 0) + Number(row.total);
    customerVisits[key] = (customerVisits[key] || 0) + 1;
    if (!customerRevenue[`${key}_name`]) customerRevenue[`${key}_name`] = row.customer_name;
  });
  const topCustomersData = [
    ['Customer Name', 'Phone', 'Total Revenue (Rs.)', 'Visits'],
    ...Object.entries(customerRevenue)
      .filter(([key]) => !key.endsWith('_name'))
      .sort((a, b) => b[1] - a[1])
      .map(([phone, revenue]) => [
        customerRevenue[`${phone}_name`] || phone,
        phone,
        Math.round(revenue * 100) / 100,
        customerVisits[phone] || 0,
      ]),
  ];

  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(summaryData), 'Summary');
  utils.book_append_sheet(wb, utils.aoa_to_sheet(servicesData), 'Top Services');
  utils.book_append_sheet(wb, utils.aoa_to_sheet(topCustomersData), 'Top Customers');

  const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });
  const dateStr = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="business-report-${dateStr}.xlsx"`);
  res.send(buf);
});
