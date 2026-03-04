import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase credentials');
      return new Response(
        JSON.stringify({ error: 'Missing database credentials' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const payload = await req.json();
    
    console.log('Received FreePay webhook:', JSON.stringify(payload));

    // FreePay webhook payload structure - fields come in PascalCase
    const transactionId = payload.Id || payload.id || payload.transaction_id || payload.data?.id;
    const status = payload.Status || payload.status || payload.data?.status;
    const amount = payload.Amount || payload.amount || payload.data?.amount;
    const paidAt = payload.PaidAt || payload.paid_at;
    const customer = payload.Customer || payload.customer || payload.data?.customer || {};
    const metadata = payload.Metadata || payload.metadata || payload.data?.metadata || {};

    console.log('Parsed webhook data:', { transactionId, status, amount, paidAt });

    // Check if payment was confirmed (PAID status)
    if (status === 'PAID' || status === 'paid' || status === 'approved') {
      console.log('Payment confirmed! Transaction:', transactionId);
      
      // Update order status to paid in database
      const { data: orderData, error: updateError } = await supabase
        .from('orders')
        .update({ 
          status: 'paid',
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transactionId)
        .select()
        .maybeSingle();

      if (updateError) {
        console.error('Error updating order status:', updateError);
      } else if (orderData) {
        console.log('Order status updated to paid:', orderData.id);
      } else {
        console.log('Order not found for transaction:', transactionId);
      }
      
      // Amount comes in reais from webhook, convert to cents
      const amountInCents = typeof amount === 'number' ? Math.round(amount * 100) : amount;
      
      // Parse items from metadata if available
      let products = [{
        id: 'ticket',
        name: 'Ingresso Ahh Verão',
        quantity: 1,
        priceInCents: amountInCents
      }];

      if (metadata.items) {
        try {
          const parsedItems = typeof metadata.items === 'string' ? JSON.parse(metadata.items) : metadata.items;
          products = parsedItems.map((item: any, index: number) => ({
            id: `ticket_${index}`,
            name: item.name,
            quantity: item.quantity,
            priceInCents: Math.round(item.price * 100)
          }));
        } catch (e) {
          console.log('Could not parse items from metadata');
        }
      }

      // Send paid notification to Utmify
      const utmifyResult = await sendToUtmify({
        orderId: transactionId,
        status: 'paid',
        createdAt: metadata.createdAt || new Date().toISOString().replace('T', ' ').substring(0, 19),
        approvedDate: new Date().toISOString().replace('T', ' ').substring(0, 19),
        refundedAt: null,
        customer: {
          name: customer.name || customer.Name || metadata.customerName || 'Cliente',
          email: customer.email || customer.Email || metadata.customerEmail || '',
          phone: customer.phone || customer.Phone || metadata.customerPhone || '',
          document: customer.document?.number || customer.Document?.Number || metadata.customerCpf || ''
        },
        products,
        totalPriceInCents: amountInCents,
        gatewayFeeInCents: Math.round(amountInCents * 0.0299) // ~3% fee estimate
      });

      console.log('Utmify paid notification result:', utmifyResult);

      return new Response(
        JSON.stringify({ 
          received: true, 
          status: 'paid',
          transactionId,
          utmifyNotified: utmifyResult.success,
          orderUpdated: !updateError
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle refunded status
    if (status === 'REFUNDED' || status === 'refunded') {
      console.log('Payment refunded! Transaction:', transactionId);
      
      // Update order status to refunded in database
      const { error: updateError } = await supabase
        .from('orders')
        .update({ 
          status: 'refunded',
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transactionId);

      if (updateError) {
        console.error('Error updating order status:', updateError);
      }
      
      const amountInCents = typeof amount === 'number' ? Math.round(amount * 100) : amount;

      const utmifyResult = await sendToUtmify({
        orderId: transactionId,
        status: 'refunded',
        createdAt: metadata.createdAt || new Date().toISOString().replace('T', ' ').substring(0, 19),
        approvedDate: metadata.approvedDate || null,
        refundedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
        customer: {
          name: customer.name || customer.Name || metadata.customerName || 'Cliente',
          email: customer.email || customer.Email || metadata.customerEmail || '',
          phone: customer.phone || customer.Phone || metadata.customerPhone || '',
          document: customer.document?.number || customer.Document?.Number || metadata.customerCpf || ''
        },
        products: metadata.products || [{
          id: 'ticket',
          name: 'Ingresso Ahh Verão',
          quantity: 1,
          priceInCents: amountInCents
        }],
        totalPriceInCents: amountInCents,
        gatewayFeeInCents: Math.round(amountInCents * 0.0299)
      });

      console.log('Utmify refunded notification result:', utmifyResult);

      return new Response(
        JSON.stringify({ 
          received: true, 
          status: 'refunded',
          transactionId,
          utmifyNotified: utmifyResult.success
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For other statuses, just acknowledge receipt
    return new Response(
      JSON.stringify({ 
        received: true, 
        status: status || 'unknown',
        transactionId 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing webhook:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
