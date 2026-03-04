import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PaymentRequest {
  amount: number;
  customerName: string;
  customerEmail: string;
  customerCpf: string;
  customerPhone: string;
  eventId?: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
  }>;
}

// Function to send order to Utmify
async function sendToUtmify(orderData: {
  orderId: string;
  status: 'waiting_payment' | 'paid' | 'refused' | 'refunded';
  createdAt: string;
  approvedDate: string | null;
  refundedAt: string | null;
  customer: {
    name: string;
    email: string;
    phone: string;
    document: string;
  };
  products: Array<{
    id: string;
    name: string;
    quantity: number;
    priceInCents: number;
  }>;
  totalPriceInCents: number;
  gatewayFeeInCents: number;
}) {
  const utmifyApiKey = Deno.env.get('UTMIFY_API_KEY');
  
  if (!utmifyApiKey) {
    console.error('UTMIFY_API_KEY not configured');
    return { success: false, error: 'Missing API key' };
  }

  const utmifyPayload = {
    orderId: orderData.orderId,
    platform: 'GuicheWeb',
    paymentMethod: 'pix',
    status: orderData.status,
    createdAt: orderData.createdAt,
    approvedDate: orderData.approvedDate,
    refundedAt: orderData.refundedAt,
    customer: {
      name: orderData.customer.name,
      email: orderData.customer.email,
      phone: orderData.customer.phone,
      document: orderData.customer.document,
      country: 'BR'
    },
    products: orderData.products.map(p => ({
      id: p.id,
      name: p.name,
      planId: null,
      planName: null,
      quantity: p.quantity,
      priceInCents: p.priceInCents
    })),
    trackingParameters: {
      src: null,
      sck: null,
      utm_source: null,
      utm_campaign: null,
      utm_medium: null,
      utm_content: null,
      utm_term: null
    },
    commission: {
      totalPriceInCents: orderData.totalPriceInCents,
      gatewayFeeInCents: orderData.gatewayFeeInCents,
      userCommissionInCents: orderData.totalPriceInCents - orderData.gatewayFeeInCents
    }
  };

  console.log('Sending to Utmify:', JSON.stringify(utmifyPayload));

  try {
    const response = await fetch('https://api.utmify.com.br/api-credentials/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': utmifyApiKey
      },
      body: JSON.stringify(utmifyPayload)
    });

    const responseText = await response.text();
    console.log('Utmify response status:', response.status);
    console.log('Utmify response:', responseText);

    return { 
      success: response.ok, 
      status: response.status,
      response: responseText 
    };
  } catch (error) {
    console.error('Error sending to Utmify:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const publicKey = Deno.env.get('FREEPAY_PUBLIC_KEY');
    const secretKey = Deno.env.get('FREEPAY_SECRET_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!publicKey || !secretKey) {
      console.error('Missing FreePay API credentials');
      return new Response(
        JSON.stringify({ error: 'Missing API credentials' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase credentials');
      return new Response(
        JSON.stringify({ error: 'Missing database credentials' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { amount, customerName, customerEmail, customerCpf, customerPhone, eventId, items }: PaymentRequest = await req.json();

    console.log('Creating PIX payment:', { amount, customerName, customerEmail, eventId, itemsCount: items.length });

    // Create Basic Auth header
    const credentials = btoa(`${publicKey}:${secretKey}`);

    // Generate unique transaction ID
    const transactionId = `PIX_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Build items array for FreePay
    const freePayItems = items.map(item => ({
      title: item.name,
      unit_price: Math.round(item.price * 100), // Convert to cents
      quantity: item.quantity,
      tangible: false,
      external_ref: transactionId
    }));

    // Build request body with correct snake_case format
    const requestBody = {
      payment_method: 'pix',
      customer: {
        document: {
          type: 'cpf',
          number: customerCpf.replace(/\D/g, ''), // Remove non-digits
        },
        name: customerName,
        email: customerEmail,
        phone: customerPhone.replace(/\D/g, ''), // Remove non-digits
      },
      items: freePayItems,
      metadata: {
        provider_name: 'GuicheWeb',
        source: 'guicheweb',
        event: 'ahh-verao',
        internal_transaction_id: transactionId,
        customerName,
        customerEmail,
        customerCpf: customerCpf.replace(/\D/g, ''),
        customerPhone: customerPhone.replace(/\D/g, ''),
        items: JSON.stringify(items)
      },
      amount: Math.round(amount * 100), // Convert to cents
      postback_url: `${supabaseUrl}/functions/v1/pix-webhook`,
      ip: '127.0.0.1',
      installments: 1,
      pix: {
        expires_in_days: 1
      }
    };

    console.log('Request body:', JSON.stringify(requestBody));

    // Call FreePay API
    const freePayResponse = await fetch('https://api.freepaybrasil.com/v1/payment-transaction/create', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('FreePay response status:', freePayResponse.status);
    
    const responseText = await freePayResponse.text();
    console.log('FreePay response text:', responseText);
    
    let freePayData;
    try {
      freePayData = responseText ? JSON.parse(responseText) : {};
    } catch (parseError) {
      console.error('Failed to parse response:', parseError);
      return new Response(
        JSON.stringify({ error: 'Invalid response from payment provider', raw: responseText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!freePayResponse.ok || !freePayData.success) {
      console.error('FreePay API error:', freePayData);
      
      // Check for CPF validation errors
      const errorMessage = JSON.stringify(freePayData).toLowerCase();
      const isCpfError = errorMessage.includes('cpf') || 
                         errorMessage.includes('document') || 
                         errorMessage.includes('invalid') ||
                         errorMessage.includes('customer');
      
      return new Response(
        JSON.stringify({ 
          error: isCpfError ? 'CPF inválido ou incorreto' : 'Failed to create PIX payment', 
          details: freePayData,
          isCpfError 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract QR Code from FreePay response (data.pix.qr_code)
    const pixData = freePayData.data?.pix;
    const copiaCola = pixData?.qr_code;

    if (!copiaCola) {
      console.error('Missing QR code data in response:', freePayData);
      return new Response(
        JSON.stringify({ 
          error: 'Invalid response from payment provider',
          debug: freePayData 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate QR code URL from the PIX code
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(copiaCola)}`;

    // Save order to database with pending status
    const { error: insertError } = await supabase
      .from('orders')
      .insert({
        transaction_id: freePayData.data?.id || transactionId,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_cpf: customerCpf.replace(/\D/g, ''),
        customer_phone: customerPhone.replace(/\D/g, ''),
        items: items,
        total_amount: amount,
        status: 'pending',
        event_id: eventId || null
      });

    if (insertError) {
      console.error('Error saving order to database:', insertError);
      // Continue anyway - payment was created successfully
    } else {
      console.log('Order saved to database with pending status');
    }

    // Send waiting_payment notification to Utmify
    const createdAtUTC = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const utmifyProducts = items.map((item, index) => ({
      id: `ticket_${index}`,
      name: item.name,
      quantity: item.quantity,
      priceInCents: Math.round(item.price * 100)
    }));

    const utmifyResult = await sendToUtmify({
      orderId: freePayData.data?.id || transactionId,
      status: 'waiting_payment',
      createdAt: createdAtUTC,
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: customerName,
        email: customerEmail,
        phone: customerPhone.replace(/\D/g, ''),
        document: customerCpf.replace(/\D/g, '')
      },
      products: utmifyProducts,
      totalPriceInCents: Math.round(amount * 100),
      gatewayFeeInCents: Math.round(amount * 100 * 0.0299) // ~3% fee estimate
    });

    console.log('Utmify waiting_payment result:', utmifyResult);

    return new Response(
      JSON.stringify({
        qrCode: qrCodeUrl,
        copiaCola,
        transactionId: freePayData.data?.id || transactionId,
        status: freePayData.data?.status || 'PENDING',
        externalId: freePayData.data?.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in create-pix-payment function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
