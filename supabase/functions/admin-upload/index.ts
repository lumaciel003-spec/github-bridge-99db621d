import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Validate admin token using HMAC signature (stateless)
async function validateAdminToken(token: string | null): Promise<boolean> {
  if (!token) {
    console.log("No token provided for validation");
    return false;
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const [payloadB64, sigB64] = parts;

    const adminPassword = Deno.env.get("ADMIN_PASSWORD") || "";
    const encoder = new TextEncoder();
    const keyData = encoder.encode(adminPassword + "_signing_secret_v1");
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payloadB64));
    if (!valid) return false;

    const payload = JSON.parse(atob(payloadB64));
    const now = Math.floor(Date.now() / 1000);
    if (now > payload.exp) return false;

    console.log("Token validation successful");
    return true;
  } catch (error) {
    console.error("Error validating token:", error);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const token = formData.get("token") as string | null;
    const imageType = formData.get("type") as string | null;

    console.log(`Admin upload request - type: ${imageType}`);

    // Validate token
    const isValidToken = await validateAdminToken(token);
    if (!isValidToken) {
      console.log("Unauthorized: invalid or missing token");
      return new Response(
        JSON.stringify({ success: false, error: "Não autorizado. Faça login novamente." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: "Nenhum arquivo enviado" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate file type
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      return new Response(
        JSON.stringify({ success: false, error: "Tipo de arquivo não permitido. Use JPG, PNG, WebP ou GIF." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      return new Response(
        JSON.stringify({ success: false, error: "Arquivo muito grande. Máximo 5MB." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate file name
    const fileExt = file.name.split('.').pop() || 'jpg';
    const fileName = `${imageType || 'image'}-${Date.now()}.${fileExt}`;

    // Upload using service role
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from('event-images')
      .upload(fileName, arrayBuffer, {
        contentType: file.type,
        upsert: false
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      throw uploadError;
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/event-images/${fileName}`;

    console.log(`Image uploaded successfully: ${publicUrl}`);

    return new Response(
      JSON.stringify({ success: true, url: publicUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
