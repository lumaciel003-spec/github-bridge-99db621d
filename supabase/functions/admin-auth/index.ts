import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// In-memory token storage (for session validation)
// In production, consider using a database table for persistence
const validTokens = new Map<string, { createdAt: number; expiresAt: number }>();

// Token expiration time (8 hours)
const TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000;

// Clean up expired tokens periodically
const cleanupExpiredTokens = () => {
  const now = Date.now();
  for (const [token, data] of validTokens.entries()) {
    if (now > data.expiresAt) {
      validTokens.delete(token);
    }
  }
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, password, token } = body;

    // Handle token validation
    if (action === "validate") {
      cleanupExpiredTokens();
      
      if (!token) {
        console.log("Token validation failed: no token provided");
        return new Response(
          JSON.stringify({ valid: false }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const tokenData = validTokens.get(token);
      const now = Date.now();
      
      if (!tokenData || now > tokenData.expiresAt) {
        console.log("Token validation failed: token invalid or expired");
        validTokens.delete(token);
        return new Response(
          JSON.stringify({ valid: false }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log("Token validation successful");
      return new Response(
        JSON.stringify({ valid: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle login
    const adminPassword = Deno.env.get("ADMIN_PASSWORD");

    if (!adminPassword) {
      console.error("ADMIN_PASSWORD not configured");
      return new Response(
        JSON.stringify({ success: false, error: "Configuração inválida" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (password === adminPassword) {
      // Generate a secure session token
      const newToken = crypto.randomUUID();
      const now = Date.now();
      
      // Store token with expiration
      validTokens.set(newToken, {
        createdAt: now,
        expiresAt: now + TOKEN_EXPIRY_MS
      });

      // Cleanup old tokens
      cleanupExpiredTokens();

      console.log("Login successful, token generated");
      
      return new Response(
        JSON.stringify({ success: true, token: newToken }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Login failed: incorrect password");
    return new Response(
      JSON.stringify({ success: false, error: "Senha incorreta" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
