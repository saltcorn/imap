const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const { getFileAggregations } = require("@saltcorn/data/models/email");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
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
    for (const table of tables) {
      if (table.get_relation_data)
        fileFields[table.name].push(...(await getFileAggregations(table)));
    }
    const dirs = await File.allDirectories();
    const roles = await User.get_roles();

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
        name: "folder",
        label: "Folder",
        sublabel: "Store attachments in this folder",
        type: "String",
        attributes: { options: dirs.map((d) => d.path_to_serve) },
      },
      {
        name: "min_role",
        label: "Minimum role",
        sublabel: "Role required to read saved attachments",
        input_type: "select",
        options: roles.map((r) => ({ value: r.id, label: r.role })),
      },
      {
        name: "mailbox_name",
        label: "Mailbox name",
        type: "String",
        default: "INBOX",
      },
      {
        name: "embed_base64",
        label: "Embed images",
        sublabel: "Embabed inline images with base64 in HTML body",
        type: "Bool",
        default: true,
      },
    ];
  },

  run: async ({ row, configuration, req }) => {
    const {
      table_dest,
      uid_field,
      file_field,
      date_field,
      subj_field,
      from_field,
      mailbox_name,
      embed_base64,
      folder,
      min_role,
      plain_body_field,
      html_body_field,
    } = configuration;
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port || 993,
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
      const newMessages = [];
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
        if (message.uid > max_uid) {
          newMessages.push(message);
          i++;
        }
      }
      for (const message of newMessages) {
        const relatedAttachments = [];
        //console.log("----\nprocessing", message);
        const newMsg = {
          [uid_field]: message.uid,
        };
        /*console.log("processing msg", message);
        console.log("childns", message.bodyStructure.childNodes);
        console.log("c0cs", message.bodyStructure.childNodes[0].childNodes);*/
        if (subj_field) newMsg[subj_field] = message.envelope.subject;
        if (from_field) newMsg[from_field] = message.envelope.from[0].address;
        if (date_field) newMsg[date_field] = message.envelope.date;

        const fetchParts = [];
        const inline_images = {};

        const iter_child_node = (childNode) => {
          //console.log("childNode", childNode);
          if (childNode.disposition === "attachment" && file_field) {
            const name =
              childNode.dispositionParameters?.filename ||
              childNode.parameters?.name;
            const type = childNode.type;
            if (name && type)
              fetchParts.push({
                part: childNode.part,
                async on_message(buf) {
                  const buf2 = Buffer.from(
                    buf.toString("utf8"),
                    "base64"
                  ).toString("utf8");
                  const file = await File.from_contents(
                    name,
                    type,
                    buf2,
                    req?.user?.id || 1,
                    min_role || 1,
                    folder || "/"
                  );
                  if (file_field.includes(".")) {
                    relatedAttachments.push(file.path_to_serve);
                    // console.log({ name, type });
                  } else newMsg[file_field] = file.path_to_serve;
                },
              });
          } else if (childNode.disposition === "inline" && embed_base64) {
            fetchParts.push({
              part: childNode.part,
              async on_message(buf) {
                const id = childNode.id.replace("<", "").replace(">", "");
                inline_images[id] = `data:${childNode.type};base64, ${buf}`;
              },
            });
          } else {
            const { type, part, encoding } = childNode;
            const bodyCfgField = {
              "text/html": "html_body_field",
              "text/plain": "plain_body_field",
            }[type];
            if (bodyCfgField && configuration[bodyCfgField])
              fetchParts.push({
                part,
                async on_message(buf) {
                  newMsg[configuration[bodyCfgField]] =
                    encoding === "quoted-printable"
                      ? QuotedPrintable.decode(buf)
                      : buf;
                },
              });
          }
          (childNode.childNodes || []).forEach(iter_child_node);
        };
        (message.bodyStructure.childNodes || []).forEach(iter_child_node);

        if (fetchParts.length) {
          const bodyParts = fetchParts.map((fp) => fp.part);
          const pmessage = await client.fetchOne(`${message.seq}`, {
            bodyParts,
          });
          for (const { part, on_message } of fetchParts) {
            if (pmessage.bodyParts) {
              const buf = pmessage.bodyParts.get(part);

              await on_message(buf, pmessage);
            }
          }
        }
        if (newMsg[html_body_field])
          Object.entries(inline_images).forEach(([id, src]) => {
            if (Buffer.isBuffer(newMsg[html_body_field]))
              newMsg[html_body_field] = newMsg[html_body_field].toString();
            newMsg[html_body_field] = newMsg[html_body_field].replace(
              `src="cid:${id}"`,
              `src="${src}"`
            );
          });
        const id = await table.insertRow(newMsg);
        //console.log({ relatedAttachments });
        if (relatedAttachments.length > 0) {
          const [ref, target] = file_field.split("->");
          const [tableNm, key] = ref.split(".");
          const attachTable = Table.findOne({ name: tableNm });
          for (const attach of relatedAttachments) {
            await attachTable.insertRow({ [key]: id, [target]: attach });
          }
        }
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
