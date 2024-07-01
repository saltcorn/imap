const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const { getFileAggregations } = require("@saltcorn/data/models/email");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const Crash = require("@saltcorn/data/models/crash");
const Trigger = require("@saltcorn/data/models/trigger");
const mailparser = require("mailparser");
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

//https://docs.sheetjs.com/docs/demos/net/email/
const concat_RS = (stream) =>
  new Promise((res, rej) => {
    var buffers = [];
    stream.on("data", function (data) {
      buffers.push(data);
    });
    stream.on("end", function () {
      res(Buffer.concat(buffers));
    });
  });

module.exports = (cfg) => ({
  configFields: async () => {
    const tables = await Table.find();
    const tableMap = {};
    tables.forEach((t) => (tableMap[t.name] = t));
    const intFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Integer").map((f) => f.name)
    );
    const strFields = objMap(tableMap, (table) => [
      "",
      ...table.fields
        .filter((f) => f.type?.name === "String")
        .map((f) => f.name),
    ]);
    const htmlFields = objMap(tableMap, (table) => [
      "",
      ...table.fields.filter((f) => f.type?.name === "HTML").map((f) => f.name),
    ]);
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
    const triggers = await Trigger.find({});

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
        name: "file_filter",
        label: "File filter",
        sublabel: "Regex filename must match. For example: *.csv",
        type: "String",
      },
      {
        name: "folder",
        label: "Attachment folder",
        sublabel: "Store attachments in this file folder",
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
        name: "copy_to_mailbox",
        label: "Copy to mailbox",
        type: "String",
        sublabel:
          "Copy messages that have been processed to this mailbox on the IMAP server.",
      },
      {
        name: "copy_error_to_mailbox",
        label: "Copy error mailbox",
        type: "String",
        sublabel:
          "Copy messages that failed processing to this mailbox on the IMAP server.",
      },
      {
        name: "error_action",
        label: "Error action",
        sublabel: "Run this action when there is an error processing an email",
        type: "String",
        attributes: {
          options: triggers.map((tr) => tr.name),
        },
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
      file_filter,
      folder,
      min_role,
      copy_to_mailbox,
      plain_body_field,
      html_body_field,
      copy_error_to_mailbox,
      error_action,
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
      const uids_to_move = [];
      const uids_to_move_to_error = [];
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
      let msgIterCount = 0;
      for (const message of newMessages) {
        console.log(
          `processing message from ${message.envelope.from[0].address} dated ${message.envelope.date} (${msgIterCount}/${newMessages.length})`
        );
        msgIterCount += 1;
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
        let stashed_text_body;
        const iter_child_node = (childNode) => {
          //console.log("--childNode", childNode);
          if (childNode.disposition === "attachment" && file_field) {
            const name =
              childNode.dispositionParameters?.filename ||
              childNode.parameters?.name;
            const type = childNode.type;
            if (file_filter && !new RegExp(file_filter).test(name)) return;
            if (name && type)
              fetchParts.push({
                part: childNode.part,
                download: true,
                uid: message.uid,
                async on_message(buf, noconv) {
                  const buf2 = noconv
                    ? buf
                    : Buffer.from(buf.toString("utf8"), "base64").toString(
                        "utf8"
                      );
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
                if (!childNode?.id) return;
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
                      ? QuotedPrintable.decode(buf).toString()
                      : encoding === "base64"
                      ? Buffer.from(buf.toString("utf8"), "base64").toString(
                          "utf8"
                        )
                      : buf.toString();
                },
              });
            else if (
              type === "text/plain" &&
              !configuration.plain_body_field &&
              configuration.html_body_field
            )
              fetchParts.push({
                part,
                async on_message(buf) {
                  stashed_text_body =
                    encoding === "quoted-printable"
                      ? QuotedPrintable.decode(buf).toString()
                      : encoding === "base64"
                      ? Buffer.from(buf.toString("utf8"), "base64").toString(
                          "utf8"
                        )
                      : buf.toString();
                },
              });
          }
          (childNode.childNodes || []).forEach(iter_child_node);
        };
        (message.bodyStructure.childNodes || []).forEach(iter_child_node);

        if (fetchParts.length) {
          const bodyParts = fetchParts.map((fp) => fp.part);
          const pmessage = await client.fetchOne(
            `${message.uid}`,
            {
              bodyParts,
            },
            { uid: true }
          );
          for (const { part, on_message, download, uid } of fetchParts) {
            if (download && uid && pmessage.bodyParts) {
              const { content } = await client.download(
                `${message.uid}`,
                part,
                { uid: true }
              );
              /* content is a stream */
              if (content) {
                const buf = await concat_RS(content);
                await on_message(buf, true);
              }
            } else if (pmessage.bodyParts) {
              const buf = pmessage.bodyParts.get(part);

              await on_message(buf);
            }
          }
        }
        if (
          !configuration.plain_body_field &&
          configuration.html_body_field &&
          !newMsg[html_body_field] &&
          stashed_text_body
        )
          newMsg[html_body_field] = stashed_text_body;
        if (
          !message.bodyStructure.childNodes &&
          !newMsg[html_body_field] &&
          !newMsg[plain_body_field]
        ) {
          const pmessage = await client.fetchOne(
            `${message.uid}`,
            {
              source: true,
              envelope: true,
            },
            { uid: true }
          );
          const source = pmessage.source.toString();
          let parsed = await mailparser.simpleParser(source);
          if (configuration.html_body_field && parsed.textAsHtml)
            newMsg[html_body_field] = parsed.textAsHtml;
          if (configuration.plain_body_field && parsed.text)
            newMsg[plain_body_field] = parsed.text;
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
        try {
          /*console.log("--------------------------");
          console.log("saving to db", newMsg);
          console.log("original msg", message);
          console.log("stashed body", stashed_text_body);
          console.log("===========================");*/
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
          if (copy_to_mailbox) {
            uids_to_move.push(message.uid);
          }
        } catch (e) {
          console.error(
            `imap save error in email from ${message.envelope.from[0].address} dated ${message.envelope.date}`,
            e
          );
          try {
            Crash.create(e, {
              url: `imap sync`,
              headers: {},
            });
            if (copy_error_to_mailbox) {
              uids_to_move_to_error.push(message.uid);
            }
            if (error_action) {
              const trigger = await Trigger.findOne({ name: error_action });
              await trigger.runWithoutRow({
                req,
                user: req?.user,
                row: message,
              });
            }
          } catch (e2) {
            console.error(
              `IMAP ERROR PROCESSING ERROR in email from ${message.envelope.from[0].address} dated ${message.envelope.date}`,
              e2
            );
          }
        }
      }
      if (copy_to_mailbox)
        for (const uid of uids_to_move) {
          console.log("Attempting to move", uid, "to", copy_to_mailbox);
          const moveResult = await client.messageMove(
            `${uid}`,
            copy_to_mailbox,
            { uid: true }
          );
          console.log("move result", moveResult);
        }
      if (copy_error_to_mailbox)
        for (const uid of uids_to_move_to_error) {
          console.log("Attempting to move", uid, "to", copy_error_to_mailbox);
          const moveResult = await client.messageMove(
            `${uid}`,
            copy_error_to_mailbox,
            { uid: true }
          );
          console.log("move result", moveResult);
        }
    } catch (e) {
      console.error(`imap sync error`, e);
      Crash.create(e, {
        url: `imap sync`,
        headers: {},
      });
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
