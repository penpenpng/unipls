import { defineConfig } from "vitepress";

export default defineConfig({
  base: process.env.DOCS_BASE ?? "/v1/",
  lang: "ja-JP",
  title: "unipls",
  description: "readiness、回復、stream lifecycleを明示的に扱う型付きWebSocket client",
  cleanUrls: true,
  lastUpdated: true,
  head: [["meta", { name: "theme-color", content: "#2563eb" }]],
  themeConfig: {
    logo: { src: "/logo.svg", alt: "unipls" },
    siteTitle: "unipls v1",
    nav: [
      { text: "はじめる", link: "/ja/getting-started" },
      { text: "ガイド", link: "/ja/operations" },
      { text: "設計", link: "/ja/concepts" },
      { text: "GitHub", link: "https://github.com/penpenpng/unipls" },
    ],
    sidebar: {
      "/ja/": [
        {
          text: "導入",
          items: [
            { text: "uniplsとは", link: "/ja/" },
            { text: "インストールと最初の接続", link: "/ja/getting-started" },
          ],
        },
        {
          text: "使い方",
          items: [
            { text: "5つの通信操作", link: "/ja/operations" },
            { text: "接続とreadiness", link: "/ja/lifecycle" },
            { text: "dropと回復", link: "/ja/recovery" },
            { text: "エラーと診断", link: "/ja/errors" },
            { text: "低レベルsocket", link: "/ja/socket" },
          ],
        },
        {
          text: "仕様と背景",
          items: [
            { text: "コアコンセプト", link: "/ja/concepts" },
            { text: "対応環境", link: "/ja/support" },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: "このページ" },
    docFooter: { prev: "前のページ", next: "次のページ" },
    lastUpdated: { text: "最終更新" },
    notFound: {
      title: "ページが見つかりません",
      quote: "URLが正しいか、ページが移動していないかを確認してください。",
      linkLabel: "ドキュメントのトップへ移動",
      linkText: "トップへ戻る",
    },
    editLink: {
      pattern: "https://github.com/penpenpng/unipls/edit/main/docs/v1/:path",
      text: "GitHubでこのページを編集",
    },
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "検索", buttonAriaLabel: "ドキュメントを検索" },
              modal: {
                noResultsText: "検索結果がありません",
                resetButtonTitle: "検索条件をリセット",
                footer: {
                  selectText: "選択",
                  navigateText: "移動",
                  closeText: "閉じる",
                },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: "https://github.com/penpenpng/unipls" }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © penpenpng",
    },
    returnToTopLabel: "ページ上部へ戻る",
    sidebarMenuLabel: "メニュー",
    darkModeSwitchLabel: "表示テーマ",
    lightModeSwitchTitle: "ライトモードへ切り替える",
    darkModeSwitchTitle: "ダークモードへ切り替える",
    skipToContentLabel: "本文へ移動",
  },
});
