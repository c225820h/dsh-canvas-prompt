// 画布提示词桥的浏览器端设置页：在 Plugins 页里给「画布提示词桥」提供一个地址输入框。
// 读写走 DSH 的设置表单服务（configForms），值最终落在 profile 的 cordis.patch.yml 里。
window.__ModuleLoader__.load({
  id: '@local/dsh-canvas-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ENTRY_ID = 'canvas-prompt';
    const DEFAULT_HINT = '内置默认 http://192.168.3.200:8799';

    let hostContext = null;

    function snapshotOf(form) {
      const snap = typeof form.getSnapshot === 'function' ? form.getSnapshot() : form.snapshot || {};
      const value = snap && snap.value ? snap.value.bridgeUrl : '';
      return { value: String(value || ''), writable: !snap || snap.writable !== false };
    }

    function BridgePage() {
      const [state, setState] = React.useState({ ready: false, value: '', draft: '', writable: true, error: '' });

      React.useEffect(() => {
        const forms = hostContext && hostContext.configForms;
        if (!forms || typeof forms.get !== 'function') {
          setState((prev) => ({ ...prev, ready: true, error: '这个 DSH 没有提供可编辑的设置表单服务，请在 profile 的 cordis.patch.yml 里改 config.bridgeUrl。' }));
          return undefined;
        }
        let alive = true;
        let unsubscribe;
        try {
          const form = forms.get(ENTRY_ID);
          const snap = snapshotOf(form);
          if (alive) setState({ ready: true, value: snap.value, draft: snap.value, writable: snap.writable, error: '' });
          if (typeof form.subscribe === 'function') {
            unsubscribe = form.subscribe(() => {
              const next = snapshotOf(form);
              if (alive) setState({ ready: true, value: next.value, draft: next.value, writable: next.writable, error: '' });
            });
          }
        } catch (error) {
          if (alive) setState((prev) => ({ ...prev, ready: true, error: String((error && error.message) || error) }));
        }
        return () => {
          alive = false;
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, []);

      const applyValue = async (next) => {
        try {
          const form = hostContext.configForms.get(ENTRY_ID);
          await form.set({ bridgeUrl: next });
          setState((prev) => ({ ...prev, value: next, draft: next, error: '' }));
        } catch (error) {
          setState((prev) => ({ ...prev, error: String((error && error.message) || error) }));
        }
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' } },
          '画布提示词桥地址。留空表示使用内置默认；保存后 canvas_prompt 会把提示词发到这个地址。'),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            value: state.draft,
            placeholder: 'http://192.168.3.200:8799',
            spellCheck: false,
            disabled: !state.ready,
            onChange: (event) => setState((prev) => ({ ...prev, draft: event.target.value })),
            style: {
              flex: 1,
              minWidth: 240,
              height: 32,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-default)',
              background: 'var(--dsw-alias-bg-elevated)',
              color: 'var(--dsw-alias-text-primary)',
              fontSize: 13,
            },
          }),
          h('button', {
            type: 'button',
            disabled: !state.ready || !state.writable,
            onClick: () => applyValue(String(state.draft || '').trim()),
            style: { height: 32, padding: '0 14px', borderRadius: 6, cursor: 'pointer' },
          }, '保存'),
          h('button', {
            type: 'button',
            disabled: !state.ready || !state.writable,
            onClick: () => applyValue(''),
            style: { height: 32, padding: '0 14px', borderRadius: 6, cursor: 'pointer' },
          }, '恢复默认'),
        ),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary)' } },
          '当前生效：' + (state.value || DEFAULT_HINT)),
        state.error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-danger)' } }, state.error) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        hostContext = ctx;
        try {
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: ENTRY_ID,
            order: 60,
          }, BridgePage));
        } catch (error) {
          console.warn('[canvas-prompt] 无法注册设置页：', error);
        }
      },
    };
  },
});
