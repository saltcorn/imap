# imap

Sync IMAP folders to tables for inbound email processing.

# how to use plugin

1. Install this module (imap in the Saltcorn module store).
   
2. Configure connection to email server in plugin settings.
   
   ![image](https://github.com/AleksandrSokolov/imap/assets/327030/a0dce3a4-2997-487b-8ada-1ece05e658d0)
   where
   * Username - your email address
   * Password - application password for your email address
   * Host - imap interface hostname of your email server
   * TLS - set if your server uses encryption

3. Create table for use by this plugin.This table will be populated with incomming emais.

   ![image](https://github.com/AleksandrSokolov/imap/assets/327030/cc8e445b-f6f2-4317-9d9c-9c0804ee394a)

   The table needs to have fields:
   * uid_field (Integer) - email id. 
   * subj_field (String - email subject
   * from_field (String)- first "from" address for email
   * file_field (File) - first file attachment for email
   * date_field (String)- email receiving date
   Field names don't matter. The presence of fields and the correct field type are important.

4. Create trigger, e.g. imap:

   ![image](https://github.com/AleksandrSokolov/imap/assets/327030/3e36e4d5-7ae3-454a-a652-993ae8e566cc)

   where
   * Name - name of trigger
   * When - use Often if wants to check mails every 5 minutes
   * Action - use action imap_sync
   * Description - just description if needed

5. Configure trigger

   ![image](https://github.com/AleksandrSokolov/imap/assets/327030/a36d0af9-4933-4202-b07a-a82fa0f4f2bd)

   where
   * Destination table - inbox table. Name can be any.
   * UID field - usuall ID. But can be any Integer field from destionation table.
   * Subject field - email subject field
   * From field - email from field
   * Date field - email receiving date field
   * File field - first attached file from email

6. Run trigger

# implemented Actions

* imap_sync - starts imap sync. 
  
# known limitations

* imap port 993
* only INBOX folder supported
* only first from adress stored
* message text is not supported
* only first file attachment stored
