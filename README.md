# Installing and Enabling PostGIS in a Dockerized PostgreSQL Database  

## 1. Use a PostgreSQL Image with PostGIS Pre-Installed  

Instead of manually installing PostGIS, use the official `postgis/postgis` image, which includes PostGIS by default.  

Run the following command to start a new PostgreSQL container with PostGIS:  

```bash
docker run --name postgis-container \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=yourpassword \
  -e POSTGRES_DB=yourdatabase \
  -d postgis/postgis
```

## 2. Connect to the Running PostgreSQL Container  

Once the container is running, access the PostgreSQL database inside the container:  

```bash
docker exec -it postgis-container psql -U postgres -d yourdatabase
```

## 3. Enable PostGIS Extension  

After connecting to the PostgreSQL shell, enable PostGIS by running the following SQL command:  

```sql
CREATE EXTENSION postgis;
```

## Alternative: Install PostGIS in a Custom PostgreSQL Image  

If you are building a custom PostgreSQL image and need to install PostGIS manually, modify your `Dockerfile` as follows:  

```dockerfile
FROM postgres:latest
RUN apt-get update && apt-get install -y postgis postgresql-15-postgis-3
```
