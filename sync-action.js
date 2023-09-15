const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const { ImapFlow } = require("imapflow");
const QuotedPrintable = require("@vlasky/quoted-printable");
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
    const htmlFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "HTML").map((f) => f.name)
    );
    const dateFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Date").map((f) => f.name)
    );
    const fileFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type === "File").map((f) => f.name)
    );
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
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "from_field",
        label: "From field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "date_field",
        label: "Date field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", dateFields],
        },
      },
      {
        name: "plain_body_field",
        label: "Text body field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "html_body_field",
        label: "HTML body field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", htmlFields],
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
      {
        name: "mailbox_name",
        label: "Mailbox name",
        type: "String",
        default: "INBOX",
      },
    ];
  },

  run: async ({
    row,
    configuration: {
      table_dest,
      uid_field,
      file_field,
      date_field,
      subj_field,
      from_field,
      mailbox_name,
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
    let lock = await client.getMailboxLock(mailbox_name || "INBOX");

    //get max uid in db
    const max_uid = await get_max_uid(table_dest, uid_field);
    try {
      const hasAttachment = [];
      let i = 0;
      for await (let message of client.fetch(
        //client.mailbox.exists,
        { uid: `${(max_uid || 0) + 1}:*` },
        {
          envelope: true,
          bodyStructure: true,
          uid: true,
        }
      )) {
        const newMsg = {
          [uid_field]: message.uid,
        };
        /*console.log("msg", message);
        console.log("childns", message.bodyStructure.childNodes);
        console.log("c0cs", message.bodyStructure.childNodes[0].childNodes);*/
        if (subj_field) newMsg[subj_field] = message.envelope.subject;
        if (from_field) newMsg[from_field] = message.envelope.from[0].address;
        if (date_field) newMsg[date_field] = message.envelope.date;
        const id = await table.insertRow(newMsg);
        const childNodes = (message.bodyStructure.childNodes || []).filter(
          (cn) => cn.disposition === "attachment"
        );
        if (childNodes.length) {
          hasAttachment.push({
            uid: message.uid,
            seq: message.seq,
            id,
            part: childNodes[0].part,
            type: childNodes[0].type,
            name:
              childNodes[0].dispositionParameters.filename ||
              childNodes[0].parameters.name,
          });
        }
        i++;
        if (i > 10) break;
      }
      if (file_field)
        for (const { uid, part, name, type, id, seq } of hasAttachment) {
          console.log(`--Fetching attachment for ${seq}: ${name}`);
          let message = await client.fetchOne(`${seq}`, {
            bodyParts: [part],
          });
          const buf0 = message.bodyParts.get(part);
          const buf2 = Buffer.from(buf0.toString("utf8"), "base64").toString(
            "utf8"
          );
          console.log(`--got attachment for ${seq}`);

          const file = await File.from_contents(
            name,
            type,
            buf2,
            req.user?.id || 1,
            1
          );
          await table.updateRow({ [file_field]: file.location }, id);
        }
    } catch (e) {
      console.error("imap sync error", e);
    } finally {
      // Make sure lock is released, otherwise next `getMailboxLock()` never returns
      lock.release();
    }

    // log out and close connection
    try {
      await client.logout();
    } catch (e) {
      console.error("imap logout error", e);
    }
  },
});
