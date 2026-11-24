// 画布提示词桥的浏览器端设置卡：注册到 Plugins 页的 plugins.item 槽位，
// 通过 DSH 的 configForms 读写本插件的 volatile 配置项 bridgeUrl。
window.__ModuleLoader__.load({
  id: '@local/dsh-canvas-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'canvas-prompt';
    const FIELD = 'bridgeUrl';
    const DEFAULT_HINT = '内置默认 http://192.168.3.200:8799';

    let hostContext = null;

    const inputStyle = {
      flex: 1,
      minWidth: 220,
      height: 32,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-default)',
      background: 'var(--dsw-alias-bg-elevated)',
      color: 'var(--dsw-alias-text-primary)',
      fontSize: 13,
    };
    const buttonStyle = { height: 32, padding: '0 14px', borderRadius: 6, cursor: 'pointer' };

    function BridgeCard() {
      const [state, setState] = React.useState({ status: 'loading', value: '', draft: '', writable: false, error: '' });

      React.useEffect(() => {
        const forms = hostContext && hostContext.configForms;
        if (!forms || typeof forms.get !== 'function') {
          setState((prev) => ({ ...prev, status: 'unavailable', error: '这个客户端没有 configForms 服务' }));
          return undefined;
        }
        let form;
        try {
          form = forms.get(NS);
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'unavailable', error: String((error && error.message) || error) }));
          return undefined;
        }
        const read = () => {
          const snap = form.getSnapshot() || {};
          const section = snap.value || {};
          const value = String((section && section[FIELD]) || '');
          setState({ status: snap.status || 'loading', value, draft: value, writable: snap.writable === true, error: '' });
        };
        read();
        const off = typeof form.subscribe === 'function' ? form.subscribe(read) : undefined;
        return () => {
          if (typeof off === 'function') off();
        };
      }, []);

      const submit = async (next) => {
        try {
          const form = hostContext.configForms.get(NS);
          const ok = await form.set(FIELD, next);
          setState((prev) => ({ ...prev, value: next, draft: next, error: ok ? '' : 'Host 没有接受这次写入' }));
        } catch (error) {
          setState((prev) => ({ ...prev, error: String((error && error.message) || error) }));
        }
      };

      const disabled = !state.writable || state.status === 'loading';

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' } },
          '画布提示词桥地址。留空表示使用内置默认；保存后 canvas_prompt 会把提示词发到这个地址。'),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            value: state.draft,
            placeholder: 'http://192.168.3.200:8799',
            spellCheck: false,
            disabled,
            onChange: (event) => setState((prev) => ({ ...prev, draft: event.target.value })),
            style: inputStyle,
          }),
          h('button', { type: 'button', disabled, onClick: () => submit(String(state.draft || '').trim()), style: buttonStyle }, '保存'),
          h('button', { type: 'button', disabled, onClick: () => submit(''), style: buttonStyle }, '恢复默认'),
        ),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary)' } },
          '当前生效：' + (state.value || DEFAULT_HINT) + '　状态：' + state.status),
        state.error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-danger)' } }, state.error) : null,
      );
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        hostContext = ctx;
        try {
          ctx.slots.inject('plugins.item', () => ctx.slots.register({
            name: 'plugins.item',
            id: NS,
            order: 60,
            label: () => '画布提示词桥',
            inject: () => ({}),
          }, BridgeCard));
        } catch (error) {
          console.warn('[canvas-prompt] 无法注册设置卡：', error);
        }
      },
    };
  },
});
