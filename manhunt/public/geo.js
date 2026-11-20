/* Geo helpers shared by the browser and the serverless API (UMD, no deps). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var R = 6371000;
  var M_PER_DEG = 111320;

  function rad(d) { return (d * Math.PI) / 180; }

  function distance(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLng = rad(b.lng - a.lng);
    var s =
      Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Move a point north/east by metres.
  function offset(p, north, east) {
    return {
      lat: p.lat + north / M_PER_DEG,
      lng: p.lng + east / (M_PER_DEG * Math.max(0.01, Math.cos(rad(p.lat)))),
    };
  }

  function centroid(pts) {
    var la = 0, ln = 0;
    for (var i = 0; i < pts.length; i++) { la += pts[i].lat; ln += pts[i].lng; }
    return { lat: la / pts.length, lng: ln / pts.length };
  }

  function inPolygon(p, pts) {
    var x = p.lng, y = p.lat, inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].lng, yi = pts[i].lat, xj = pts[j].lng, yj = pts[j].lat;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // zone: {shape:'circle', center:{lat,lng}, radius} | {shape:'polygon', points:[{lat,lng}]}
  function inZone(p, z) {
    if (!z) return true;
    if (z.shape === 'circle') return distance(p, z.center) <= z.radius;
    if (z.shape === 'polygon') return inPolygon(p, z.points);
    return true;
  }

  // Apply shrinking / moving over game progress (0..1).
  // opts: {progress, shrinkEnd (0..1 fraction of the size left at the end, or null), moveM, bearing (radians)}
  function zoneAt(z, opts) {
    if (!z) return null;
    var progress = Math.max(0, Math.min(1, opts.progress || 0));
    var s = opts.shrinkEnd != null ? 1 - progress * (1 - opts.shrinkEnd) : 1;
    var d = opts.moveM ? opts.moveM * progress : 0;
    var bearing = opts.bearing || 0;
    var dn = Math.cos(bearing) * d;
    var de = Math.sin(bearing) * d;
    if (z.shape === 'circle') {
      return { shape: 'circle', center: offset(z.center, dn, de), radius: z.radius * s };
    }
    var c = centroid(z.points);
    var cl = Math.cos(rad(c.lat));
    return {
      shape: 'polygon',
      points: z.points.map(function (p) {
        var n = (p.lat - c.lat) * M_PER_DEG * s;
        var e = (p.lng - c.lng) * M_PER_DEG * cl * s;
        return offset(c, n + dn, e + de);
      }),
    };
  }

  function randomIn(z, rnd) {
    rnd = rnd || Math.random;
    if (!z) return null;
    if (z.shape === 'circle') {
      var r = z.radius * Math.sqrt(rnd());
      var a = rnd() * 2 * Math.PI;
      return offset(z.center, r * Math.cos(a), r * Math.sin(a));
    }
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    z.points.forEach(function (p) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    });
    for (var i = 0; i < 200; i++) {
      var c = { lat: minLat + rnd() * (maxLat - minLat), lng: minLng + rnd() * (maxLng - minLng) };
      if (inPolygon(c, z.points)) return c;
    }
    return centroid(z.points);
  }

  // Outline as an array of {lat,lng} (circles become polygons) for drawing masks.
  function ring(z, steps) {
    if (!z) return [];
    if (z.shape === 'polygon') return z.points.slice();
    steps = steps || 72;
    var out = [];
    for (var i = 0; i < steps; i++) {
      var a = (i / steps) * 2 * Math.PI;
      out.push(offset(z.center, z.radius * Math.cos(a), z.radius * Math.sin(a)));
    }
    return out;
  }

  function validPoint(p) {
    return (
      p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
      isFinite(p.lat) && isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180
    );
  }

  return {
    distance: distance, offset: offset, centroid: centroid, inPolygon: inPolygon,
    inZone: inZone, zoneAt: zoneAt, randomIn: randomIn, ring: ring, validPoint: validPoint,
  };
});
