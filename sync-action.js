const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const { ImapFlow } = require("imapflow");

module.exports = (cfg) => ({
  configFields: async ({ table }) => {
    const tables = await Table.find();
    const file_fields = table.fields.find((f) => f.type === "File");
    return [
      {
        name: "table_dest",
        label: "Destination table",
        sublabel: "Table to sync to",
        input_type: "select",
        required: true,
        options: tables.map((t) => t.name),
      },
      {
        name: "file_field",
        label: "File field",
        type: "String",
        required: true,
        attributes: {
          options: file_fields.map((f) => f.name),
        },
      },
    ];
  },
  /**
   * @param {object} opts
   * @param {object} opts.row
   * @param {object} opts.configuration
   * @param {object} opts.user
   * @returns {Promise<void>}
   */
  run: async ({ row, configuration: { table_dest, file_field } }) => {
    const client = new ImapFlow({
      host: cfg.host,
      port: 993,
      secure: !!cfg.tls,
      auth: {
        user: cfg.username,
        pass: cfg.password,
      },
    });
    await client.connect();

    // Select and lock a mailbox. Throws if mailbox does not exist
    let lock = await client.getMailboxLock("INBOX");
    try {
      // fetch latest message source
      // client.mailbox includes information about currently selected mailbox
      // "exists" value is also the largest sequence number available in the mailbox
      let message = await client.fetchOne(client.mailbox.exists, {
        source: true,
      });
      console.log(message.source.toString());

      // list subjects for all messages
      // uid value is always included in FETCH response, envelope strings are in unicode.
      for await (let message of client.fetch("1:*", { envelope: true })) {
        console.log(`${message.uid}: ${message.envelope.subject}`);
      }
    } finally {
      // Make sure lock is released, otherwise next `getMailboxLock()` never returns
      lock.release();
    }

    // log out and close connection
    await client.logout();
  },
});
