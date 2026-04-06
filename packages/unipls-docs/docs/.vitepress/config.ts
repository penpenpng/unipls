import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'unipls Docs',
  description: 'Documentation site scaffold for unipls',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'English', link: '/en/v1/' },
      { text: '日本語', link: '/ja/v1/' },
    ],
    sidebar: {
      '/en/v1/': [
        {
          text: 'v1',
          items: [
            { text: 'Overview', link: '/en/v1/' },
            { text: 'Guide', link: '/en/v1/guide' },
          ],
        },
      ],
      '/ja/v1/': [
        {
          text: 'v1',
          items: [
            { text: '概要', link: '/ja/v1/' },
            { text: 'ガイド', link: '/ja/v1/guide' },
          ],
        },
      ],
    },
  },
});
