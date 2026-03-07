const CACHE_NAME = "my-music-cache-v2";

self.addEventListener("install", event => {

    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll([
                "./",
                "./index.html"
            ]);
        })
    );

});

self.addEventListener("fetch", event => {

    // кешируем mp3
    if (event.request.url.includes(".mp3")) {

        event.respondWith(

            caches.match(event.request).then(response => {

                if (response) {
                    return response;
                }

                return fetch(event.request).then(networkResponse => {

                    return caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });

                });

            })

        );

    } else {

        event.respondWith(
            caches.match(event.request).then(response => {
                return response || fetch(event.request);
            })
        );

    }

});