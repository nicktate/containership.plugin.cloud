FROM mhart/alpine-node:6.11

WORKDIR /root
ADD . /root

RUN npm install

ENTRYPOINT ["node", "index.js"]
