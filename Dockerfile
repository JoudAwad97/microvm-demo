# Lambda MicroVM image build. This is a normal container build. Lambda runs the
# Dockerfile on top of a managed Amazon Linux 2023 base image (supplied
# separately via --base-image-arn), starts the app, calls the POST /ready build
# hook, then snapshots the running VM. ARM64 only at launch.
FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./

# The MicroVM serves on port 8080 (claims C18, C30).
EXPOSE 8080
CMD ["node", "server.mjs"]
