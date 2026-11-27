# PixCart database and images

| File / folder | What it is |
|---|---|
| `pixcart_demo_db.sql` | The whole database in one file: creates the database `pixcart_demo`, every table with its keys and indexes, and all the data (no views, stored procedures or triggers are used). |
| `media/` | Every public file the data points to (product photos, partner photos), at the same paths as in the database (`/media/products/....webp`). |
| `private/` | Every private file the data points to (partner ID proofs, delivery proof photos), at the same paths as in the database. They are demo placeholder images, not real documents. |

The data is demo data: sample sellers, products, shoppers and orders, with no sign-in sessions, logs or real contact
details. Only the admin below has a password; every other account signs in with a one-time code.

MySQL version used: **MySQL 8.4** (tested with 8.4.13 Community Server, default settings, utf8mb4).

## 1. Import (one command)

```
mysql -u root -p < db/pixcart_demo_db.sql
```

Optional, an application user instead of root:

```sql
CREATE USER 'pixcart'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON pixcart_demo.* TO 'pixcart'@'localhost';
```

## 2. Images

Copy the two folders into the API's storage folders (paths are relative to the folder the API runs from):

| Copy | To | Setting |
|---|---|---|
| `db/media/*` | `PixCartAPI/API/var/media/` (IIS: `<site folder>\var\media\`) | `App:MediaRoot` |
| `db/private/*` | `PixCartAPI/API/var/private/` (IIS: `<site folder>\var\private\`) | `App:PrivateRoot` |

Keep the sub-folders (`products/`, `delivery/`, `delivery-kyc/`, `delivery-proof/`). The API serves `/media/...`
itself; private files are only served to signed-in staff and the owner.

## 3. Connection string

In `PixCartAPI/API/appsettings.json`, section `App`, set `ConnectionString` (or the environment variable
`App__ConnectionString`, which wins over the file):

```json
"ConnectionString": "Server=127.0.0.1;Port=3306;Database=pixcart_demo;User=pixcart;Password=choose-a-password;"
```

## 4. Migrations

Nothing to run. The project uses Dapper with SQL scripts (no Entity Framework): the API applies the scripts in
`PixCartAPI/DAL/Helpers/Scripts/V###__*.sql` on start and records them in the table `schema_versions`. This database
is already at the latest script (V004), so the API starts with "Database is up to date".

## 5. Sign in

| Who | Sign-in |
|---|---|
| Admin panel (`/admin/login`) | `admin@pixcart.in` / `PixCart@Demo2026` (change it in Admin → My account) |
| Customer (`/login`) | phone `9999900001` |
| Seller (`/seller`) | phone `9000000001` |
| Delivery partner (`/delivery`) | phone `7300000001` |

Phone sign-ins use a one-time code. In development (no SMS provider connected) the code is shown on the sign-in
screen and written to the API log.

## 6. Production

Encrypted fields (seller PAN and bank account, delivery partner ID proof) are encrypted with the development key in
`appsettings.json` (`App:FieldEncryptionKey`). In production the API refuses to start without its own key, so set
`App__Environment=production`, `App__JwtSecret`, `App__FieldEncryptionKey` and `App__CookieSecure=true` (see
`docs/DEPLOY_WINDOWS_IIS.md`); with a new key the few demo values above can no longer be read and should be entered
again in the admin panel. Provider keys (payments, SMS, email, AI) are entered in Admin → Integrations.

## Verified

On a new, empty MySQL 8.4 server: the import above (79 tables), the images copied as in step 2, the API started with
only the connection string changed; then, through the website: home, category listing, search, product detail and
"my orders" with every image loading (no broken image, no failed request), customer sign-in with the code from the
screen, admin sign-in, admin dashboard, products (with photos), product detail and orders.
