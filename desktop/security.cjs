function isAppUrl(value, appOrigin) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === appOrigin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isTrustedSender(event, contents, appOrigin) {
  return (
    event.sender === contents &&
    event.senderFrame === contents.mainFrame &&
    isAppUrl(event.senderFrame.url, appOrigin)
  );
}

module.exports = { isAppUrl, isExternalUrl, isTrustedSender };
