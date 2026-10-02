// Talking to the family server: JSON in and out, errors with the server's own words.

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, type = null, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: {}, signal };
  if (body !== undefined) {
    if (type) {
      init.headers['Content-Type'] = type;
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Can’t reach Beam Family right now. Check your connection.');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    // (a refused sign-in is just a wrong password, not a sign-out)
    if (res.status === 401 && path !== '/api/signin') window.dispatchEvent(new CustomEvent('family:signed-out', { detail: data }));
    throw new ApiError(res.status, data?.error || `Something went wrong (${res.status})`, data);
  }
  return data;
}

export const get = (path, opts) => api(path, opts);
export const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body });
export const put = (path, body, opts = {}) => api(path, { ...opts, method: 'PUT', body });
export const patch = (path, body, opts = {}) => api(path, { ...opts, method: 'PATCH', body });
export const del = (path, body, opts = {}) => api(path, { ...opts, method: 'DELETE', body });
