const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const { ImapFlow } = require("imapflow");

const objMap = (obj, f) => {
  const result = {};
  Object.keys(obj).forEach((k) => {
    result[k] = f(obj[k]);
  });
  return result;
};

module.exports = (cfg) => ({
  configFields: async () => {
    const tables = await Table.find();
    const tableMap = {};
    tables.forEach((t) => (tableMap[t.name] = t));
    const intFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Integer").map((f) => f.name)
    );
    const strFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "String").map((f) => f.name)
    );
    console.log("intFields", intFields);
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
        name: "uid_field",
        label: "UID field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", intFields],
        },
      },
      {
        name: "subj_field",
        label: "Subject field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "from_field",
        label: "From field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
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
      console.log("exists", 60659); //client.mailbox.exists);
      let message = await client.fetchOne(client.mailbox.exists, {
        envelope: true,
        bodyStructure: true,
        uid: true,
        //bodyParts: ["2"],
      });
      console.log("envelope", message.envelope);
      console.log("uid", message.uid);
      console.log("bodyStructure", message.bodyStructure);
      console.log("bodyParts", message.bodyParts);

      // list subjects for all messages
      // uid value is always included in FETCH response, envelope strings are in unicode.
      //for await (let message of client.fetch("1:*", { envelope: true })) {
      //  console.log(`${message.uid}: ${message.envelope.subject}`);
      //}
    } finally {
      // Make sure lock is released, otherwise next `getMailboxLock()` never returns
      lock.release();
    }

    // log out and close connection
    await client.logout();
  },
});
