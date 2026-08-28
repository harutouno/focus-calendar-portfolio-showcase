import { useCallback, useEffect, useRef, useState } from "react";
import { AiChatHistoryEntry } from "@/types/ai";
import { clearAiChatHistory, getAiChatHistory } from "@/storage/aiChatHistoryRepository";
import { useAuthOptional } from "@/context/AuthContext";
import { authIdentityKey } from "@/auth/authSessionIdentityStore";
import { useAuthIdentity } from "@/auth/useAuthIdentity";
import { useOnLogout } from "@/hooks/useOnLogout";

/**
 * P0051 (QA-F007-C19最終): entriesを「どのidentityの結果か」というownerIdentityKeyと
 * 共に1つのstateへ束ねる。呼び出し元へ公開するentriesはrender時点で
 * `ownerIdentityKey === 現在のidentityKey`かどうかだけで機械的にmaskする
 * （useEffectによる非同期リセットを待たず、identity切替直後の最初のrenderから
 * 前の持ち主の履歴を一切公開しない）。
 */
export interface OwnedHistoryState {
  ownerIdentityKey: string;
  entries: AiChatHistoryEntry[];
}

function initialOwnedState(identityKey: string): OwnedHistoryState {
  return { ownerIdentityKey: identityKey, entries: [] };
}

/**
 * P0051: pure関数として切り出し、Reactのrender/effectを一切介さずに直接検証できるようにする
 * （「テストがReactのact()自動flushによって、reset effectが走る前の1フレームの漏洩を
 * 見えなくしてしまう」という穴を作らないため）。
 */
export function selectVisibleHistoryEntries(
  owned: OwnedHistoryState,
  currentIdentityKey: string
): AiChatHistoryEntry[] {
  return owned.ownerIdentityKey === currentIdentityKey ? owned.entries : [];
}

/**
 * AIホーム画面の履歴一覧表示用の薄いフック。書き込み（appendAiChatHistory）は
 * app/ai/processing.tsx側（結果受信の唯一の場所）が直接リポジトリを呼ぶため、
 * このフックは読み出し専用。
 *
 * SEC-F006-001: chatHistoryはユーザーIDを持たない端末単位のStorageのため、
 * ログアウト（認証済み→未認証への実際の遷移）を検知した時点でこの端末の履歴を
 * 消去する。これにより、ログアウト後の未ログイン状態・別ユーザーでの再ログインの
 * いずれからも、前ユーザーの自由入力・AI応答が閲覧できてしまう状態を防ぐ。
 * 画面上のstate（entries）は即時に空へ戻し、永続化側のclearAiChatHistory()の
 * 成否とは関係なく前ユーザーの内容が再表示されないようにする。
 *
 * SEC-F006-001残存修正: clearAiChatHistory()自体が失敗した場合に備え、読み込み側
 * （getAiChatHistory）でも所有ユーザーの一致を検証する二重の防御を持つ。これにより
 * 「Storage削除は失敗したが、次回の再マウント・アプリ再起動・別ユーザーのログインでは
 * 前ユーザーの項目を復元しない」という、プロセス再起動をまたいだ永続的な保護になる
 * （詳細は`aiChatHistoryRepository.getAiChatHistory`のownerUserIdフィルタを参照）。
 *
 * P0050 (SEC-F007-002): useOnLogoutは非null→null（実際のログアウト）のみ検知し、
 * 非null→非null（同一マウント中のA→B切替）は検知できない。そのためrefresh()の
 * 読み込みeffectはuserIdだけでなくsessionInstanceId込みのidentityKey
 * （既存のC01/C02 identity contractと同じ形）に依存させ、A→B・同一ユーザーの
 * 新セッションのいずれでも再読込を発火させる。加えてrefresh()自体もidentityKeyを
 * 捕捉し、await後に別の持ち主へ切り替わっていれば結果を破棄する（stale-adoption防止）。
 *
 * P0051 (QA-F007-C19最終): 上記のeffect起点のリセットに加え、entriesをowner-tagged
 * stateとして保持し、render時点でmaskする（下記return文参照）。これにより、
 * identity切替後・reset effectがまだ走っていない最初のrenderでも前の持ち主の
 * entriesが一切公開されない（従来はeffectが走るまでの1フレーム、古いentriesが
 * 見える可能性があった）。
 */
export function useAiChatHistory() {
  const auth = useAuthOptional();
  const authLoading = auth?.loading ?? false;
  // P0148 (SEC-F007-005) §3: 「誰の履歴を読み、誰に見せるか」はセキュリティ判断のため、
  // AuthContextのReact state（setCurrentAuthIdentityより後に更新される＝遅れうる）ではなく
  // 権威ストアを直接購読して決める。AuthContextからはloadingだけを使う。
  const identity = useAuthIdentity();
  const identityKey = authIdentityKey(identity);
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const prevIdentityKeyRef = useRef<string | undefined>(undefined);

  const [owned, setOwned] = useState<OwnedHistoryState>(() => initialOwnedState(identityKey));

  const userIdRef = useRef<string | null>(identity.userId);
  userIdRef.current = identity.userId;

  const refresh = useCallback(async () => {
    // DATA-F002-002: getAiChatHistoryは形状不正なトップレベルデータに対してthrowするように
    // なったため、未処理のPromise拒否を防ぐためだけに明示的にcatchする（開発時のみログ）。
    // 失敗時は履歴を空のまま扱う（会話履歴は再現可能な補助的データのため実害は小さい）。
    const requestedIdentityKey = identityKeyRef.current;
    try {
      const history = await getAiChatHistory(userIdRef.current);
      if (identityKeyRef.current !== requestedIdentityKey) return;
      setOwned({ ownerIdentityKey: requestedIdentityKey, entries: history });
    } catch (e) {
      if (identityKeyRef.current !== requestedIdentityKey) return;
      if (__DEV__) {
        console.warn("[useAiChatHistory] 会話履歴の読み込みに失敗しました", e);
      }
    }
  }, []);

  useEffect(() => {
    // 認証状態が未確定（セッション復元中）の間は待つ。ここで先にnull扱いのまま
    // 読み込んでしまうと、実際にはログイン済みのユーザー自身の項目まで
    // 一時的に除外して表示してしまうため（authLoading確定後にのみ1回読み込む）。
    if (authLoading) return;
    if (prevIdentityKeyRef.current !== undefined && prevIdentityKeyRef.current !== identityKey) {
      // 別ユーザー、または同一ユーザーの新セッションへ切り替わった。再読込が終わるまで
      // 前の持ち主の履歴を画面に残さないよう、同期的に空へ戻してから読み込み直す。
      // P0051: render-time maskingがあるため必須ではないが、内部stateもここで
      // 前の持ち主のentriesを持ち続けないよう安全側で揃えておく。
      setOwned(initialOwnedState(identityKey));
    }
    prevIdentityKeyRef.current = identityKey;
    refresh();
  }, [refresh, authLoading, identityKey]);

  useOnLogout(
    useCallback(() => {
      setOwned(initialOwnedState(identityKeyRef.current));
      clearAiChatHistory();
    }, [])
  );

  // P0051 (QA-F007-C19最終): render-time owner masking。ownerIdentityKeyが現在の
  // identityKeyと一致しない場合（同一マウント中のidentity切替直後、reset effectが
  // まだ走っていない最初のrenderを含む）、前の持ち主のentriesを一切公開しない。
  return {
    entries: selectVisibleHistoryEntries(owned, identityKey),
    refresh,
  };
}
