const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Plugin = require("@saltcorn/data/models/plugin");
const { getOauth2Client } = require("@saltcorn/data/models/email");
const { domReady } = require("@saltcorn/markup/tags");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "IMAP account",
        form: async (context) => {
          return new Form({
            fields: [
              {
                name: "auth_method",
                label: "Authentication method",
                type: "String",
                required: true,
                sublabel: "Choose the authentication method",
                attributes: {
                  options: [
                    { label: "OAuth2", name: "oauth2" },
                    { label: "Basic", name: "credentials" },
                  ],
                  onChange: "authMethodChange(this)",
                },
              },
              {
                name: "username",
                label: "Username",
                type: "String",
                required: true,
              },
              {
                name: "password",
                label: "Password",
                input_type: "password",
                required: true,
                showIf: { auth_method: "credentials" },
              },
              {
                name: "client_id",
                label: "Client ID",
                type: "String",
                required: true,
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "client_secret",
                label: "Client Secret",
                type: "String",
                required: true,
                input_type: "password",
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "authorize_url",
                label: "Authorize URL",
                type: "String",
                required: true,
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "token_url",
                label: "Token URL",
                type: "String",
                required: true,
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "redirect_uri",
                label: "Redirect URI",
                type: "String",
                required: true,
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "scopes",
                label: "Scopes",
                type: "String",
                required: true,
                showIf: { auth_method: "oauth2" },
              },
              {
                name: "host",
                label: "Host",
                type: "String",
                required: true,
              },
              {
                name: "tls",
                label: "TLS",
                type: "Bool",
              },
              {
                name: "port",
                label: "Port",
                type: "Integer",
                default: 993,
                sublabel: "Standard ports are 143 or 993",
              },
            ],
            additionalButtons: [
              {
                label: "authorize",
                id: "imap_authorize_btn",
                onclick: "location.href='/imap/authorize'",
                class: "btn btn-primary d-none",
              },
            ],
            additionalHeaders: [
              {
                headerTag: `<script>
  function authMethodChange(element) {
    const val = element.value;
    const authBtn = document.getElementById('imap_authorize_btn');
    if (val === "oauth2") {
      authBtn.classList.remove('d-none');
    }
    else {
      authBtn.classList.add('d-none');
    }
  }
  ${domReady(`
    const authMethod = document.getElementById('inputauth_method');
    if (authMethod) {
      authMethodChange(authMethod);
    }
  `)}
</script>`,
              },
            ],
          });
        },
      },
    ],
  });

const routes = (config) => {
  const {
    client_id,
    client_secret,
    token_url,
    authorize_url,
    redirect_uri,
    scopes,
  } = config || {};
  return [
    {
      url: "/imap/authorize",
      method: "get",
      callback: async (req, res) => {
        const role = req?.user?.role_id || 100;
        if (role > 1) {
          req.flash("error", req.__("Not authorized"));
          return res.redirect("/");
        }
        const client = getOauth2Client({
          clientId: client_id,
          clientSecret: client_secret,
          tokenUrl: token_url,
          authorizeUrl: authorize_url,
        });
        const scopeArray = scopes.split(" ").map((s) => s.trim());
        const authorizeUrl = client.authorizeURL({
          redirect_uri: redirect_uri,
          scope: scopeArray,
        });
        res.redirect(authorizeUrl);
      },
    },
    {
      url: "/imap/callback",
      method: "get",
      callback: async (req, res) => {
        const role = req?.user?.role_id || 100;
        if (role > 1) {
          req.flash("error", req.__("Not authorized"));
          return res.redirect("/");
        }
        const { code } = req.query;
        if (!code) {
          req.flash("error", req.__("No code provided"));
          return res.redirect("/");
        }
        const client = getOauth2Client({
          clientId: client_id,
          clientSecret: client_secret,
          tokenUrl: token_url,
          authorizeUrl: authorize_url,
        });
        let plugin = await Plugin.findOne({ name: "imap" });
        if (!plugin) {
          plugin = await Plugin.findOne({
            name: "@saltcorn/imap",
          });
        }
        try {
          const { token } = await client.getToken({
            code,
            redirect_uri: redirect_uri,
          });
          const newConfig = {
            ...(plugin.configuration || {}),
            token: token,
          };
          plugin.configuration = newConfig;
          await plugin.upsert();
          getState().processSend({
            refresh_plugin_cfg: plugin.name,
            tenant: db.getTenantSchema(),
          });
          req.flash(
            "success",
            req.__("Authentication successful! You can now use IMAP.")
          );
        } catch (error) {
          console.error("Error retrieving access token:", error);
          req.flash("error", req.__("Error retrieving access"));
        } finally {
          res.redirect(`/plugins/configure/${encodeURIComponent(plugin.name)}`);
        }
      },
    },
  ];
};

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap",
  configuration_workflow,
  routes,
  actions: (cfg) => ({ imap_sync: require("./sync-action")(cfg) }),
};
