// dsh-multi2api —— Web UI 管理面板（浏览器侧）。
//
// 说明：这里只依赖 react（从宿主模块表取），不加载任何其它 Harness 客户端包；
// 控件与样式都按宿主的做法自己写，颜色只用 --dsw-alias-* 主题变量，跟随深浅色。
window.__ModuleLoader__.load({
  id: "dsh-multi2api",
  factory: function (require) {
    const React = require("react");

    const ROUTE_PREFIX = "/plugins/dsh-multi2api";
    const REFRESH_MS = 15000;

    const en = {
      tabLabel: "Multi2API Accounts",
      title: "Multi2API Accounts",
      intro:
        "Each account becomes its own model in DSH, so sessions never cross accounts. Add an account, or switch a session to a different account model.",
      running: "Running",
      stopped: "Not running",
      port: "Port",
      dataDir: "Data folder",
      restart: "Restart service",
      restarting: "Restarting…",
      refresh: "Refresh",
      autoCheckin: "Auto check-in",
      autoCheckinOnHint: "On: every DSH start signs in all accounts once.",
      autoCheckinOffHint: "Off: no automatic sign-in.",
      accounts: "Accounts",
      accountCardUnnamed: "Unnamed account",
      credits: "Credits",
      cooling: "Cooling",
      disabled: "Disabled",
      checkedIn: "Checked in today",
      notCheckedIn: "Not checked in today",
      checkIn: "Check in",
      deleteAccount: "Delete",
      confirmDelete: "Delete this account? The service will restart.",
      model: "Model",
      login: "Add account",
      loginHint: "Scan or open the link below in a browser to sign in. This panel will finish automatically.",
      openLogin: "Open sign-in page",
      waitingLogin: "Waiting for sign-in…",
      loginDone: "Account added.",
      cancel: "Cancel",
      importAccount: "Import account files",
      importHint:
        "Pick one or several credential JSON files exported from another machine, or paste the JSON below. Each file adds one account.",
      pickFiles: "Choose files…",
      pickHint: "You can select several JSON files at once.",
      orPaste: "Or paste JSON",
      importing: "Importing…",
      import: "Import",
      imported: "Imported",
      importPartial: "Some files were skipped",
      failed: "Failed",
      logs: "Service log",
      showLogs: "Show log",
      hideLogs: "Hide log",
      loadFailed: "Could not read status",
      saveFailed: "Operation failed",
      autoModel: "Auto (highest-credit healthy account)",
      empty: "No accounts yet. Use “Add account” to sign in.",
      noCredits: "—",
      catalog: "Upstream models & credit rate",
      catalogHint:
        "Read straight from the upstream account, so this is the live list. The credit rate is how many credits one call costs.",
      catalogFailed: "Could not read upstream models",
      refreshModels: "Re-read upstream models",
      refreshingModels: "Reading…",
      colModel: "Model",
      colRate: "Credit rate",
      colContext: "Context",
      colCapability: "Ability",
      capReasoning: "reasoning",
      capImages: "images",
      capTools: "tools",
      noCatalog: "No upstream model list yet. Try “Re-read upstream models”.",
      accountAlias: "Alias",
      modelCount: "Models",
      colEnable: "On",
      enableHint:
        "Tick a model to add it to DSH’s model list. Unticked models stay hidden, so the chat model picker stays short.",
      accountEnable: "Enable",
      accountEnableHint:
        "Turn an account off and it stops showing up in the model list. New accounts are on by default.",
      enabledCount: "Enabled",
      selectionSaved: "Saved",
      modelHidden: "Off",
      modelEnable: "Turn this model on",
    };

    const zh = {
      tabLabel: "Multi2API 账号池",
      title: "Multi2API 账号池",
      intro:
        "每个账号在 DSH 里就是一个独立模型，会话互不干扰。加号用“添加账号”，换号时把这个会话切到对应账号的模型即可。",
      running: "运行中",
      stopped: "未运行",
      port: "端口",
      dataDir: "数据目录",
      restart: "重启服务",
      restarting: "重启中…",
      refresh: "刷新",
      autoCheckin: "自动签到",
      autoCheckinOnHint: "已开：每次启动 DSH 会给所有账号签到一次。",
      autoCheckinOffHint: "已关：不自动签到。",
      accounts: "账号",
      accountCardUnnamed: "未命名账号",
      credits: "积分",
      cooling: "冷却中",
      disabled: "已停用",
      checkedIn: "今天已签到",
      notCheckedIn: "今天未签到",
      checkIn: "签到",
      deleteAccount: "删除",
      confirmDelete: "确定删除这个账号吗？服务会重启。",
      model: "模型",
      login: "添加账号",
      loginHint: "用浏览器打开下面的登录链接完成登录，本面板会自动完成后续步骤。",
      openLogin: "打开登录页",
      waitingLogin: "等待登录中…",
      loginDone: "账号已添加。",
      cancel: "取消",
      importAccount: "导入账号文件",
      importHint:
        "选一个或多个从别的机器导出的凭证 JSON 文件，每个文件添加一个账号；也可以直接把内容粘在下面。",
      pickFiles: "选择文件…",
      pickHint: "可以一次选多个 JSON 文件。",
      orPaste: "或粘贴内容",
      importing: "导入中…",
      import: "导入",
      imported: "已导入",
      importPartial: "部分文件被跳过",
      failed: "失败",
      logs: "服务日志",
      showLogs: "查看日志",
      hideLogs: "收起日志",
      loadFailed: "读取状态失败",
      saveFailed: "操作失败",
      autoModel: "自动（积分最高的健康账号）",
      empty: "还没有账号。点“添加账号”登录。",
      noCredits: "—",
      catalog: "上游模型与积分倍率",
      catalogHint: "直接从上游账号读取，所以这里是实时列表。倍率就是每次调用扣多少积分。",
      catalogFailed: "读取上游模型失败",
      refreshModels: "重新读取上游模型",
      refreshingModels: "读取中…",
      colModel: "模型",
      colRate: "积分倍率",
      colContext: "上下文",
      colCapability: "能力",
      capReasoning: "推理",
      capImages: "图片",
      capTools: "工具",
      noCatalog: "还没有上游模型列表，点“重新读取上游模型”试试。",
      accountAlias: "别名",
      modelCount: "模型数",
      colEnable: "启用",
      enableHint: "勾上的模型才会出现在 DSH 的模型列表里，没勾的就不显示，聊天界面的选择框才不会被塞满。",
      accountEnable: "启用",
      accountEnableHint: "关掉的账号不会出现在模型列表里。新加的账号默认是开的。",
      enabledCount: "已启用",
      selectionSaved: "已保存",
      modelHidden: "未启用",
      modelEnable: "启用这个模型",
    };

    const namespace = "settings.multi2api";

    async function request(path, init) {
      const response = await fetch(`${ROUTE_PREFIX}${path}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        ...init,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return body;
    }

    function post(path, payload) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    }

    function formatCredits(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return number.toLocaleString();
    }

    // 上游给的倍率是文案，形如 "x0.11 credits" / "x0.05" / "x0.00 credits"，
    // 直接原样显示最不容易出错；只把空值换成占位符。
    function formatRate(value) {
      const text = String(value ?? "").trim();
      return text.length > 0 ? text : "—";
    }

    function formatContext(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size <= 0) return "—";
      if (size >= 1000) return `${Math.round(size / 1000)}K`;
      return String(size);
    }

    function timeText(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return "";
      return date.toLocaleString();
    }

    function Button(props) {
      const { variant = "secondary", disabled, children, onClick } = props;
      const background =
        variant === "primary"
          ? "var(--dsw-alias-brand-primary)"
          : variant === "danger"
            ? "transparent"
            : "var(--dsw-alias-bg-layer-2)";
      const color =
        variant === "primary"
          ? "var(--dsw-alias-bg-base)"
          : variant === "danger"
            ? "var(--dsw-alias-state-error-primary)"
            : "var(--dsw-alias-label-primary)";
      return React.createElement(
        "button",
        {
          type: "button",
          className: "m2a-btn",
          disabled: disabled === true,
          onClick,
          style: {
            background,
            color,
            border:
              variant === "primary"
                ? "1px solid transparent"
                : variant === "danger"
                  ? "1px solid var(--dsw-alias-border-l2)"
                  : "1px solid var(--dsw-alias-border-l1)",
          },
        },
        children,
      );
    }

    function Badge(props) {
      const tone = props.tone ?? "idle";
      const color =
        tone === "ok"
          ? "var(--dsw-alias-state-success-primary)"
          : tone === "warn"
            ? "var(--dsw-alias-state-warn-primary)"
            : tone === "error"
              ? "var(--dsw-alias-state-error-primary)"
              : "var(--dsw-alias-label-tertiary)";
      return React.createElement(
        "span",
        {
          className: "m2a-badge",
          style: { color, borderColor: "var(--dsw-alias-border-l1)" },
        },
        props.children,
      );
    }

    // 开关控件：一个圆角轨道 + 一个圆点，纯 CSS，不依赖 UI 库。
    function Switch(props) {
      const checked = props.checked === true;
      const disabled = props.disabled === true;
      return React.createElement(
        "label",
        {
          className: "m2a-switch",
          title: props.title ?? "",
          style: { opacity: disabled ? 0.55 : 1, cursor: disabled ? "default" : "pointer" },
        },
        React.createElement("input", {
          type: "checkbox",
          checked,
          disabled,
          onChange: (event) => {
            if (disabled) return;
            props.onChange?.(event.target.checked === true);
          },
          style: { position: "absolute", opacity: 0, width: 0, height: 0 },
        }),
        React.createElement("span", {
          className: "m2a-switch-track",
          style: {
            background: checked ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-bg-layer-2)",
            borderColor: "var(--dsw-alias-border-l1)",
          },
        }, React.createElement("span", { className: "m2a-switch-knob", style: { left: checked ? 15 : 2 } })),
        React.createElement("span", { className: "m2a-switch-label" }, props.label),
      );
    }

    function Row(props) {
      return React.createElement(
        "div",
        { className: "m2a-row" },
        React.createElement("span", { className: "m2a-key" }, props.label),
        React.createElement("span", { className: "m2a-value" }, props.children),
      );
    }

    function Multi2ApiPanel(props) {
      const t = props.t;
      const [status, setStatus] = React.useState(undefined);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [login, setLogin] = React.useState(undefined);
      const [importOpen, setImportOpen] = React.useState(false);
      const [importText, setImportText] = React.useState("");
      const [pasteOpen, setPasteOpen] = React.useState(false);
      const [autoCheckin, setAutoCheckin] = React.useState(true);
      const fileInputRef = React.useRef(null);
      const [logsOpen, setLogsOpen] = React.useState(false);
      const [logs, setLogs] = React.useState("");
      const mounted = React.useRef(true);

      const load = React.useCallback(async () => {
        try {
          const body = await request("/status", {});
          if (mounted.current) {
            setStatus(body);
            setError("");
          }
          // 开关状态存在插件数据目录里，单独读一次。
          const settings = await request("/settings", {});
          if (mounted.current && typeof settings?.autoCheckin === "boolean") {
            setAutoCheckin(settings.autoCheckin);
          }
        } catch (loadError) {
          if (mounted.current) setError(String(loadError.message ?? loadError));
        }
      }, []);

      React.useEffect(() => {
        mounted.current = true;
        void load();
        const timer = window.setInterval(() => {
          void load();
        }, REFRESH_MS);
        return () => {
          mounted.current = false;
          window.clearInterval(timer);
        };
      }, [load]);

      // 登录轮询：拿到 state 后每 2 秒问一次。
      React.useEffect(() => {
        if (login === undefined || login.state === undefined) return undefined;
        let stopped = false;
        const tick = async () => {
          try {
            const body = await post("/login/poll", { state: login.state });
            if (stopped) return;
            if (body?.done === true) {
              if (body.ok === true) {
                setLogin(undefined);
                setNotice(t("loginDone"));
                await load();
              } else {
                setLogin(undefined);
                setError(String(body?.error ?? t("saveFailed")));
              }
            }
          } catch (pollError) {
            if (!stopped) setError(String(pollError.message ?? pollError));
          }
        };
        const timer = window.setInterval(() => {
          void tick();
        }, 2000);
        return () => {
          stopped = true;
          window.clearInterval(timer);
        };
      }, [login, load, t]);

      const run = async (name, action) => {
        setBusy(name);
        setError("");
        setNotice("");
        try {
          await action();
        } catch (runError) {
          setError(String(runError.message ?? runError));
        } finally {
          if (mounted.current) setBusy("");
        }
      };

      const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
      const running = status?.running === true;
      const catalog = Array.isArray(status?.catalog) ? status.catalog : [];
      const modelRows = Array.isArray(status?.models) ? status.models : [];

      // 勾/取消勾一个模型：后端会重算模型列表并换掉 pi-ai 快照。
      const toggleModel = async (id, enabled) => {
        await run(`model:${id}`, async () => {
          await post("/selection/save", { kind: "model", id, enabled });
          setNotice(t("selectionSaved"));
          await load();
        });
      };

      // 开关一个账号：关掉的号不会注册成模型。
      const toggleAccount = async (uid, enabled) => {
        await run(`account:${uid}`, async () => {
          await post("/selection/save", { kind: "account", uid, enabled });
          setNotice(t("selectionSaved"));
          await load();
        });
      };

      return React.createElement(
        "div",
        { className: "m2a-root" },
        React.createElement(
          "div",
          { className: "m2a-head" },
          React.createElement("h2", { className: "m2a-title" }, t("title")),
          React.createElement("p", { className: "m2a-intro" }, t("intro")),
        ),
        React.createElement(
          "div",
          { className: "m2a-panel" },
          React.createElement(
            "div",
            { className: "m2a-toolbar" },
            React.createElement(Badge, { tone: running ? "ok" : "error" }, running ? t("running") : t("stopped")),
            running
              ? React.createElement(Badge, null, `${t("port")} ${status.port}`)
              : null,
            React.createElement("span", { className: "m2a-spacer" }),
            React.createElement(
              Button,
              {
                disabled: busy !== "",
                onClick: () => {
                  void run("refresh", load);
                },
              },
              t("refresh"),
            ),
            React.createElement(
              Button,
              {
                disabled: busy !== "" || running !== true,
                onClick: () => {
                  void run("refreshModels", async () => {
                    const body = await post("/refresh-models", {});
                    if (body?.ok !== true) throw new Error(body?.error ?? t("saveFailed"));
                    setNotice(`${t("catalog")}: ${body.catalog?.length ?? 0}`);
                    await load();
                  });
                },
              },
              busy === "refreshModels" ? t("refreshingModels") : t("refreshModels"),
            ),
            React.createElement(
              Switch,
              {
                checked: autoCheckin === true,
                disabled: busy !== "",
                label: t("autoCheckin"),
                title: autoCheckin === true ? t("autoCheckinOnHint") : t("autoCheckinOffHint"),
                onChange: (next) => {
                  void run("autoCheckin", async () => {
                    const body = await post("/settings/save", { autoCheckin: next });
                    if (body?.ok !== true) throw new Error(body?.error ?? t("saveFailed"));
                    setAutoCheckin(body.autoCheckin === true);
                  });
                },
              },
            ),
            React.createElement(
              Button,
              {
                disabled: busy !== "",
                onClick: () => {
                  void run("restart", async () => {
                    const body = await post("/restart", {});
                    if (body?.ok !== true) throw new Error(body?.error ?? t("saveFailed"));
                    await load();
                  });
                },
              },
              busy === "restart" ? t("restarting") : t("restart"),
            ),
            React.createElement(
              Button,
              {
                variant: "primary",
                disabled: busy !== "",
                onClick: () => {
                  void run("login", async () => {
                    const body = await post("/login/start", {});
                    if (body?.ok !== true) throw new Error(body?.error ?? t("saveFailed"));
                    setLogin({ state: body.state, authUrl: body.authUrl });
                    window.open(body.authUrl, "_blank", "noopener,noreferrer");
                  });
                },
              },
              t("login"),
            ),
          ),
          React.createElement(
            "div",
            { className: "m2a-meta" },
            React.createElement(Row, { label: t("dataDir") }, status?.dataDir ?? "—"),
            status?.error ? React.createElement(Row, { label: t("saveFailed") }, status.error) : null,
            status?.statusError ? React.createElement(Row, { label: t("loadFailed") }, status.statusError) : null,
          ),
          error ? React.createElement("p", { className: "m2a-error" }, error) : null,
          notice ? React.createElement("p", { className: "m2a-notice" }, notice) : null,

          login !== undefined
            ? React.createElement(
                "div",
                { className: "m2a-login" },
                React.createElement("p", { className: "m2a-hint" }, t("loginHint")),
                React.createElement(
                  "a",
                  {
                    className: "m2a-link",
                    href: login.authUrl,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  t("openLogin"),
                ),
                React.createElement("p", { className: "m2a-hint" }, t("waitingLogin")),
                React.createElement(
                  Button,
                  {
                    onClick: () => {
                      setLogin(undefined);
                    },
                  },
                  t("cancel"),
                ),
              )
            : null,

          React.createElement(
            "div",
            { className: "m2a-section" },
            React.createElement("h3", { className: "m2a-subtitle" }, `${t("accounts")} (${accounts.length})`),
            accounts.length === 0
              ? React.createElement("p", { className: "m2a-empty" }, t("empty"))
              : React.createElement(
                  "div",
                  { className: "m2a-grid" },
                  accounts.map((account) =>
                    React.createElement(
                      "div",
                      { className: "m2a-card", key: account.uid },
                      React.createElement(
                        "div",
                        { className: "m2a-card-head" },
                        React.createElement(
                          "span",
                          { className: "m2a-card-name" },
                          account.displayName || t("accountCardUnnamed"),
                        ),
                        account.disabled === true ? React.createElement(Badge, { tone: "error" }, t("disabled")) : null,
                        account.cooling === true ? React.createElement(Badge, { tone: "warn" }, t("cooling")) : null,
                        React.createElement(
                          Badge,
                          { tone: account.checkedInToday === true ? "ok" : "idle" },
                          account.checkedInToday === true ? t("checkedIn") : t("notCheckedIn"),
                        ),
                      ),
                      React.createElement(Row, { label: t("credits") }, formatCredits(account.credits)),
                      account.alias
                        ? React.createElement(Row, { label: t("accountAlias") }, account.alias)
                        : null,
                      account.alias
                        ? React.createElement(
                            Row,
                            { label: t("modelCount") },
                            String(modelRows.filter((row) => row.alias === account.alias).length),
                          )
                        : null,
                      account.cooling === true && timeText(account.until)
                        ? React.createElement(Row, { label: t("cooling") }, `${timeText(account.until)} ${account.reason ?? ""}`)
                        : null,
                      React.createElement(
                        "div",
                        { className: "m2a-card-actions" },
                        React.createElement(Switch, {
                          checked: account.enabled !== false,
                          disabled: busy !== "",
                          label: t("accountEnable"),
                          title: t("accountEnableHint"),
                          onChange: (next) => {
                            void toggleAccount(account.uid, next);
                          },
                        }),
                        React.createElement(
                          Button,
                          {
                            variant: "danger",
                            disabled: busy !== "",
                            onClick: () => {
                              if (!window.confirm(t("confirmDelete"))) return;
                              void run(`delete:${account.uid}`, async () => {
                                const body = await post("/accounts/delete", { uid: account.uid });
                                if (body?.ok !== true) throw new Error(body?.error ?? t("saveFailed"));
                                await load();
                              });
                            },
                          },
                          t("deleteAccount"),
                        ),
                      ),
                    ),
                  ),
                ),
          ),

          // 上游模型清单 + 积分倍率，从上游账号实时读取。
          React.createElement(
            "div",
            { className: "m2a-section" },
            React.createElement(
              "div",
              { className: "m2a-toolbar" },
              React.createElement(
                "h3",
                { className: "m2a-subtitle" },
                `${t("catalog")} (${t("enabledCount")} ${catalog.filter((item) => item.enabled === true).length}/${catalog.length})`,
              ),
              React.createElement("span", { className: "m2a-spacer" }),
            ),
            React.createElement("p", { className: "m2a-hint" }, t("catalogHint")),
            React.createElement("p", { className: "m2a-hint" }, t("enableHint")),
            status?.catalogError
              ? React.createElement(
                  "p",
                  { className: "m2a-error" },
                  `${t("catalogFailed")}: ${status.catalogError}`,
                )
              : null,
            catalog.length === 0
              ? React.createElement("p", { className: "m2a-empty" }, t("noCatalog"))
              : React.createElement(
                  "table",
                  { className: "m2a-table" },
                  React.createElement(
                    "thead",
                    null,
                    React.createElement(
                      "tr",
                      null,
                      React.createElement("th", { className: "m2a-check-col" }, t("colEnable")),
                      React.createElement("th", null, t("colModel")),
                      React.createElement("th", null, t("colRate")),
                      React.createElement("th", null, t("colContext")),
                      React.createElement("th", null, t("colCapability")),
                    ),
                  ),
                  React.createElement(
                    "tbody",
                    null,
                    catalog.map((item) =>
                      React.createElement(
                        "tr",
                        { key: item.id, className: item.enabled === true ? "" : "m2a-row-off" },
                        React.createElement(
                          "td",
                          { className: "m2a-check-col" },
                          React.createElement("input", {
                            type: "checkbox",
                            className: "m2a-check",
                            checked: item.enabled === true,
                            disabled: busy !== "",
                            title: item.enabled === true ? t("colEnable") : t("modelEnable"),
                            onChange: (event) => {
                              void toggleModel(item.id, event.target.checked);
                            },
                          }),
                        ),
                        React.createElement("td", null, item.name || item.id),
                        React.createElement("td", { className: "m2a-num" }, formatRate(item.credits)),
                        React.createElement("td", { className: "m2a-num" }, formatContext(item.contextWindow)),
                        React.createElement(
                          "td",
                          null,
                          [
                            item.reasoning === true ? t("capReasoning") : "",
                            item.images === true ? t("capImages") : "",
                            item.toolCall === true ? t("capTools") : "",
                          ]
                            .filter((text) => text.length > 0)
                            .join(" · ") || "—",
                        ),
                      ),
                    ),
                  ),
                ),
          ),

          React.createElement(
            "div",
            { className: "m2a-section" },
            React.createElement(
              "div",
              { className: "m2a-toolbar" },
              React.createElement("h3", { className: "m2a-subtitle" }, t("importAccount")),
              React.createElement("span", { className: "m2a-spacer" }),
              React.createElement(
                Button,
                {
                  onClick: () => {
                    setImportOpen(!importOpen);
                  },
                },
                importOpen ? t("cancel") : t("import"),
              ),
            ),
            importOpen
              ? React.createElement(
                  "div",
                  { className: "m2a-import" },
                  React.createElement("p", { className: "m2a-hint" }, t("importHint")),
                  // 选择文件：浏览器只允许用户主动点选，所以用一个隐藏的 file input，
                  // 用按钮去触发它。multiple 允许一次选多个文件。
                  React.createElement("input", {
                    ref: fileInputRef,
                    type: "file",
                    accept: ".json,application/json",
                    multiple: true,
                    style: { display: "none" },
                    onChange: (event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      if (files.length === 0) return;
                      void run("import", async () => {
                        const docs = [];
                        for (const file of files) {
                          try {
                            docs.push(JSON.parse(await file.text()));
                          } catch {
                            throw new Error(`${file.name}: JSON 格式不对`);
                          }
                        }
                        const body = await post("/accounts/import", { docs });
                        if (body?.ok !== true) {
                          const reason = body?.failed?.[0]?.error ?? body?.error ?? t("saveFailed");
                          throw new Error(reason);
                        }
                        const count = body.imported?.length ?? 0;
                        const skipped = body.failed?.length ?? 0;
                        setNotice(
                          skipped > 0
                            ? `${t("imported")}: ${count} · ${t("importPartial")}: ${skipped}`
                            : `${t("imported")}: ${count}`,
                        );
                        await load();
                      });
                    },
                  }),
                  React.createElement(
                    Button,
                    {
                      variant: "primary",
                      disabled: busy !== "",
                      onClick: () => {
                        fileInputRef.current?.click();
                      },
                    },
                    busy === "import" ? t("importing") : t("pickFiles"),
                  ),
                  React.createElement("span", { className: "m2a-hint" }, t("pickHint")),
                  React.createElement(
                    "div",
                    { className: "m2a-paste-toggle" },
                    React.createElement(
                      Button,
                      {
                        onClick: () => {
                          setPasteOpen(!pasteOpen);
                        },
                      },
                      pasteOpen ? t("cancel") : t("orPaste"),
                    ),
                  ),
                  pasteOpen
                    ? React.createElement(
                        "div",
                        { className: "m2a-paste-body" },
                        React.createElement("textarea", {
                          className: "m2a-textarea",
                          rows: 6,
                          value: importText,
                          spellCheck: false,
                          onChange: (event) => {
                            setImportText(event.target.value);
                          },
                        }),
                        React.createElement(
                          Button,
                          {
                            variant: "primary",
                            disabled: busy !== "" || importText.trim().length === 0,
                            onClick: () => {
                              void run("import", async () => {
                                let doc;
                                try {
                                  doc = JSON.parse(importText);
                                } catch {
                                  throw new Error("JSON 格式不对");
                                }
                                const body = await post("/accounts/import", { doc });
                                if (body?.ok !== true) {
                                  const reason =
                                    body?.failed?.[0]?.error ?? body?.error ?? t("saveFailed");
                                  throw new Error(reason);
                                }
                                setImportText("");
                                setPasteOpen(false);
                                setNotice(`${t("imported")}: ${body.imported?.length ?? 0}`);
                                await load();
                              });
                            },
                          },
                          t("import"),
                        ),
                      )
                    : null,
                )
              : null,
          ),

          React.createElement(
            "div",
            { className: "m2a-section" },
            React.createElement(
              "div",
              { className: "m2a-toolbar" },
              React.createElement("h3", { className: "m2a-subtitle" }, t("logs")),
              React.createElement("span", { className: "m2a-spacer" }),
              React.createElement(
                Button,
                {
                  onClick: () => {
                    const next = !logsOpen;
                    setLogsOpen(next);
                    if (next) {
                      void run("logs", async () => {
                        const body = await request("/logs?lines=300", {});
                        setLogs(String(body?.text ?? ""));
                      });
                    }
                  },
                },
                logsOpen ? t("hideLogs") : t("showLogs"),
              ),
            ),
            logsOpen ? React.createElement("pre", { className: "m2a-logs" }, logs) : null,
          ),
        ),
      );
    }

    const styleText = [
      ".m2a-root{max-width:760px;display:flex;flex-direction:column;gap:12px}",
      ".m2a-title{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".m2a-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
      ".m2a-panel{display:flex;flex-direction:column;gap:10px}",
      ".m2a-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".m2a-spacer{flex:1}",
      ".m2a-btn{border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;line-height:1.4}",
      ".m2a-btn:disabled{opacity:.5;cursor:default}",
      ".m2a-switch{position:relative;display:inline-flex;align-items:center;gap:6px;font-size:13px;user-select:none}",
      ".m2a-switch-track{position:relative;display:inline-block;width:32px;height:18px;border:1px solid;border-radius:999px;transition:background .15s ease}",
      ".m2a-switch-knob{position:absolute;top:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s ease}",
      ".m2a-switch-label{white-space:nowrap}",
      ".m2a-badge{font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;white-space:nowrap}",
      ".m2a-meta{display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}",
      ".m2a-row{display:flex;gap:8px;font-size:13px}",
      ".m2a-key{color:var(--dsw-alias-label-tertiary);min-width:64px}",
      ".m2a-value{color:var(--dsw-alias-label-primary);word-break:break-all}",
      ".m2a-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin:0}",
      ".m2a-notice{color:var(--dsw-alias-state-success-primary);font-size:13px;margin:0}",
      ".m2a-hint{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}",
      ".m2a-login{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px}",
      ".m2a-link{color:var(--dsw-alias-brand-primary);font-size:13px}",
      ".m2a-section{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}",
      ".m2a-subtitle{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".m2a-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}",
      ".m2a-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}",
      ".m2a-card{display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px}",
      ".m2a-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".m2a-card-name{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}",
      ".m2a-card-actions{display:flex;gap:8px;align-items:center;margin-top:2px}",
      ".m2a-import{display:flex;flex-direction:column;gap:8px;align-items:flex-start}",
      ".m2a-table{width:100%;border-collapse:collapse;font-size:13px}",
      ".m2a-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 8px 4px 0}",
      ".m2a-table td{color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 8px 4px 0}",
      ".m2a-check-col{width:44px}",
      ".m2a-check{width:15px;height:15px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,rgb(56,132,255))}",
      ".m2a-check:disabled{cursor:default;opacity:.5}",
      ".m2a-row-off td{color:var(--dsw-alias-label-tertiary)}",
      ".m2a-num{font-family:monospace;white-space:nowrap}",
      ".m2a-paste-toggle{margin-top:2px}",
      ".m2a-paste-body{display:flex;flex-direction:column;gap:8px;align-items:flex-start;width:100%}",
      ".m2a-textarea{width:100%;font-family:monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;resize:vertical}",
      ".m2a-logs{max-height:320px;overflow:auto;font-size:12px;font-family:monospace;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
    ].join("\n");

    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected) return;
      styleInjected = true;
      const element = document.createElement("style");
      element.setAttribute("data-plugin", "dsh-multi2api");
      element.textContent = styleText;
      document.head.appendChild(element);
    }

    return {
      name: "dsh-multi2api",
      inject: ["slots", "locale"],
      apply(ctx) {
        try {
          ensureStyle();
          ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-multi2api: 面板文案");
          const t = ctx.locale.bind(namespace);
          ctx.slots.inject("settings.plugins.tab", () =>
            ctx.slots.register(
              {
                name: "settings.plugins.tab",
                id: "multi2api",
                order: 31,
                label: () => t("tabLabel"),
                locale: namespace,
                inject: () => ({ t }),
              },
              Multi2ApiPanel,
            ),
          );
        } catch (error) {
          console.error("[dsh-multi2api] 面板注册失败", error);
        }
      },
    };
  },
});
