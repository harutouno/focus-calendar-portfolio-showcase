import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * 共有機能（ログイン・共有カレンダー・同期）が使える状態かどうか。
 * .env が未設定でも個人利用（端末内保存）は動き続けるよう、ここで判定する。
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/**
 * 未設定時はダミーURLでクライアントを作るだけに留め、実際の呼び出しは
 * isSupabaseConfigured を確認したコード側（AuthContext/共有系service）でガードする。
 */
export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : "https://placeholder.supabase.co",
  isSupabaseConfigured ? supabaseAnonKey : "placeholder-anon-key",
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      // RN/Expoではブラウザのリダイレクトが無いため、Magic Linkは
      // ?code= を使うPKCEフローにする（app/auth/callback.tsxで交換する）。
      flowType: "pkce",
    },
  }
);
