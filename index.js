const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "IMAP account",
        form: async (context) => {
          return new Form({
            fields: [
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
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap",
  configuration_workflow,
  actions: (cfg) => ({ imap_sync: require("./sync-action")(cfg) }),
};
