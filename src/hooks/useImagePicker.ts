import { useCallback, useState } from "react";
import * as ImagePicker from "expo-image-picker";

export interface PickImageOptions {
  /** 切り抜き比率。アバターは[1,1]、カバーは横長を想定 */
  aspect?: [number, number];
}

export interface PickedImage {
  uri: string;
}

/**
 * ギャラリーから画像を1枚選ぶための共通Hook。
 * 権限が無い・キャンセルされた場合はnullを返すだけで、例外は投げない
 * （呼び出し側はnullなら何もしない＝Avatar/CoverImageは既存のフォールバック表示のまま）。
 */
export function useImagePicker() {
  const [picking, setPicking] = useState(false);

  const pickImage = useCallback(
    async (options: PickImageOptions = {}): Promise<PickedImage | null> => {
      setPicking(true);
      try {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          return null;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 0.7,
          allowsEditing: true,
          aspect: options.aspect ?? [1, 1],
        });
        if (result.canceled || !result.assets || result.assets.length === 0) {
          return null;
        }
        return { uri: result.assets[0].uri };
      } catch {
        return null;
      } finally {
        setPicking(false);
      }
    },
    []
  );

  return { pickImage, picking };
}
