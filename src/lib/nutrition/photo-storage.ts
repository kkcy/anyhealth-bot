import { getSupabase } from "@/lib/supabase";
import { createHash } from "node:crypto";

export function buildMealPhotoStoragePath(phone: string, mimeType: string, now = Date.now()): string {
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const phoneHash = createHash("sha256").update(phone).digest("hex").slice(0, 16);
  return `${phoneHash}/${now}.${ext}`;
}

export async function uploadMealPhoto(args: {
  phone: string;
  bytes: ArrayBuffer;
  mimeType: string;
}): Promise<{ storagePath: string; signedUrl: string }> {
  const sb = getSupabase();
  const path = buildMealPhotoStoragePath(args.phone, args.mimeType);

  const upload = await sb.storage.from("meal-photos").upload(path, args.bytes, {
    contentType: args.mimeType,
    upsert: false,
  });
  if (upload.error) throw upload.error;

  const signed = await sb.storage.from("meal-photos").createSignedUrl(path, 10 * 60);
  if (signed.error || !signed.data?.signedUrl) {
    throw signed.error ?? new Error("Failed to create signed URL");
  }

  return { storagePath: path, signedUrl: signed.data.signedUrl };
}
