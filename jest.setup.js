/* global jest */
jest.mock(
  "@react-native-async-storage/async-storage",
  () => require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// @react-native-google-signin/google-signin はネイティブモジュール（RNGoogleSignin）を
// importと同時に読み込むため、テスト環境（ネイティブバイナリ無し）ではimportした瞬間に
// 例外を投げる。authService.tsがトップレベルでimportしており、authService.ts自体を
// 直接importしないテストファイルでも registry.ts 経由で間接的に読み込まれるため、
// 全テストで共通のダミー実装に差し替える（個別のシナリオを確認したいテスト
// （authService.socialSignIn.test.ts等）は、そのテストファイル内でjest.mock(...)を
// 再度呼んでこのデフォルトを上書きする）。
jest.mock("@react-native-google-signin/google-signin", () => {
  const GoogleSigninButtonMock = () => null;
  GoogleSigninButtonMock.Size = { Icon: 0, Standard: 1, Wide: 2 };
  GoogleSigninButtonMock.Color = { Dark: "dark", Light: "light" };
  return {
    __esModule: true,
    GoogleSignin: {
      configure: jest.fn(),
      hasPlayServices: jest.fn().mockResolvedValue(true),
      signIn: jest.fn().mockResolvedValue({ type: "cancelled", data: null }),
    },
    GoogleSigninButton: GoogleSigninButtonMock,
    isErrorWithCode: jest.fn().mockReturnValue(false),
    isSuccessResponse: jest.fn((response) => response?.type === "success"),
    isCancelledResponse: jest.fn((response) => response?.type === "cancelled"),
    statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED", IN_PROGRESS: "IN_PROGRESS" },
  };
});

// Stage I-4: renderHook/act（@testing-library/react-native）を使うテスト向け。
// 未設定だと act(...) 環境警告が出るだけで失敗はしないが、警告を出さないようにしておく。
global.IS_REACT_ACT_ENVIRONMENT = true;

// [P0080 AUTH-F013-F017-001] captureSharedMutationAuthSnapshotは実際のSupabaseセッション
// （supabase.auth.getSession()）を読むため、テスト環境（実Supabase接続無し）ではそのままだと
// 全テストが失敗する。staleness判定自体は実際のassertCurrentSharedMutationIdentity
// （モックしない、authSessionIdentityStoreと照合する本物のロジック）をそのまま再利用しつつ、
// supabase.auth.getSession()の呼び出しだけをaccessTokenの付与に差し替えたデフォルトを
// 全テストへ提供する（個別に実際のPostgREST/RPC呼び出しを検証したいテスト
// （sharedEventsService.test.ts等）は、そのテストファイル内でjest.mock(...)を再度呼んで
// このデフォルトを上書きする）。
jest.mock("@/auth/sharedMutationAuthSnapshot", () => {
  const { assertCurrentSharedMutationIdentity } = jest.requireActual("@/auth/sharedMutationIdentity");
  const captureSharedMutationAuthSnapshot = jest.fn(async (identity) => {
    assertCurrentSharedMutationIdentity(identity);
    return { ...identity, accessToken: "jest-mock-access-token" };
  });
  // P0154 (SEC-AUTH-TRANSPORT-001) による既定の変更:
  //
  // 以前の既定は「createPinnedSharedClient は必ず throw する」だった。pinned client を
  // 使う経路がごく一部だった当時は、それが「気付かずに壊れたクライアントを掴む」ことを
  // 防ぐ有効なガードだった。しかし P0154 で **identity-scoped な mutation は全て**
  // pinned transport になったため、この既定のままでは「共有カレンダー/添付の mutation に
  // 触れる全テストファイルが定型のモック上書きを書かないと落ちる」状態になり、
  // ガードとしての意味より障害の方が大きくなった。
  //
  // そこで既定を「**モックされた ambient supabase クライアントへ委譲する** pinned client」
  // へ変更する。これにより:
  //   - 既存テストの「どのテーブル/バケットへ何を送ったか」というアサーションはそのまま通り、
  //   - **セキュリティ上の本質（stale/不一致な identity では送出しない）は失われない**。
  //     その判定は createPinnedSharedClient ではなく
  //     captureSharedMutationAuthSnapshot 内の本物の assertCurrentSharedMutationIdentity が
  //     行っており、上の既定モックでも本物のまま実行される。
  // 送出元が pinned であること自体を検証したいテストは、これまでどおり
  // jest.mock(...) でこのモジュールを上書きして専用の fake client を渡す。
  const createPinnedSharedClient = jest.fn(() => {
    const mocked = jest.requireMock("@/lib/supabaseClient");
    if (!mocked || !mocked.supabase) {
      throw new Error(
        "createPinnedSharedClient default mock needs a mocked @/lib/supabaseClient. Add jest.mock(\"@/lib/supabaseClient\", ...) to this test file, or override @/auth/sharedMutationAuthSnapshot with a fake pinned client."
      );
    }
    return mocked.supabase;
  });
  return {
    captureSharedMutationAuthSnapshot,
    createPinnedSharedClient,
    // P0154 (SEC-AUTH-TRANSPORT-001): `withPinnedSharedClient` は「1回の送出のために
    // 捕捉してpinnedクライアントを渡す」薄いラッパである。デフォルトモックでも
    // **本物と同じ合成**（capture → createPinnedSharedClient）にしておくことで、
    //   - 上書きしたテストファイルは、その上書きだけで両方の経路を制御でき、
    //   - 上書きしていないテストファイルは、これまでどおり
    //     createPinnedSharedClient の明示的な「not mocked」エラーで気付ける
    // （＝サイレントに通ってしまう抜け道を作らない）。
    withPinnedSharedClient: jest.fn(async (identity, send) =>
      send(createPinnedSharedClient(await captureSharedMutationAuthSnapshot(identity)))
    ),
  };
});
