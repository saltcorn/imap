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
const get_max_uid = async (table_dest, uid_field) => {
  const schema = db.getTenantSchemaPrefix();

  const { rows } = await db.query(
    `select max(${db.sqlsanitize(uid_field)}) from ${schema}"${db.sqlsanitize(
      table_dest
    )}"`
  );
  //console.log({ rows });
  return rows[0].max;
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
    const fileFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type === "File").map((f) => f.name)
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
      {
        name: "file_field",
        label: "File field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", fileFields],
        },
      },
    ];
  },

  run: async ({
    row,
    configuration: {
      table_dest,
      uid_field,
      file_field,
      subj_field,
      from_field,
    },
    req,
  }) => {
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
    const table = await Table.findOne({ name: table_dest });
    // Select and lock a mailbox. Throws if mailbox does not exist
    let lock = await client.getMailboxLock("INBOX");

    //get max uid in db
    const max_uid = await get_max_uid(table_dest, uid_field);
    try {
      const hasAttachment = [];
      let i = 0;
      for await (let message of client.fetch(`${max_uid || 0}:*`, {
        envelope: true,
        bodyStructure: true,
        uid: true,
      })) {
        console.log(`${message.uid}: ${message.envelope.subject}`);
        await table.insertRow(
          {
            [uid_field]: message.uid,
            [subj_field]: message.envelope.subject,
            [from_field]: message.envelope.from[0].address,
          },
          req.user
        );
        const childNodes = (message.bodyStructure.childNodes || []).filter(
          (cn) => cn.disposition === "attachment"
        );
        if (childNodes.length) {
          hasAttachment.push({
            uid: message.uid,
            part: childNodes[0].part,
          });
        }
        i++;
        if (i > 10) break;
      }
      for (const { uid, part } of hasAttachment) {
        let message = await client.fetchOne(
          { uid },
          {
            bodyParts: [part],
          }
        );
        const buf = message.bodyParts.get(part);
      }
      // fetch latest message source
      // client.mailbox includes information about currently selected mailbox
      // "exists" value is also the largest sequence number available in the mailbox
      console.log("exists", 60659); //client.mailbox.exists);

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
