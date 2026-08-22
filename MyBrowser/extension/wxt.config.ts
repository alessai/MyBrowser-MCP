import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'MyBrowser',
    version: '1.2.0',
    description: 'Local and remote browser automation through MCP',
    permissions: [
      'debugger',
      'scripting',
      'storage',
      'tabs',
      'webNavigation',
      'alarms',
      'offscreen',
      'downloads',
      'clipboardRead',
      'clipboardWrite',
    ],
    host_permissions: ['<all_urls>'],
    commands: {
      open_annotation: {
        suggested_key: {
          default: 'Alt+Shift+A',
          mac: 'Alt+Shift+A',
        },
        description: 'Draw annotation and save as a note for Claude',
      },
    },
  },
  modules: ['@wxt-dev/module-react'],
});
