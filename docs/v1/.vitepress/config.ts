import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/v1/',
  title: 'unipls Docs',
  description: 'Documentation site scaffold for unipls',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'English', link: '/en/' },
      { text: '日本語', link: '/ja/' },
    ],
    sidebar: {
      '/en/': [
        {
          text: 'v1',
          items: [
            { text: 'Overview', link: '/en/' },
            { text: 'Guide', link: '/en/guide' },
          ],
        },
      ],
      '/ja/': [
        {
          text: 'v1',
          items: [
            { text: '概要', link: '/ja/' },
            { text: 'コアコンセプト', link: '/ja/concepts' },
            { text: 'ガイド', link: '/ja/guide' },
            { text: '対応runtime', link: '/ja/support' },
          ],
        },
      ],
    },
  },
});
