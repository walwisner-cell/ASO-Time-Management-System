(function () { try { var c = localStorage.getItem('trothen_theme') || 'auto';
    var d = c === 'dark' || (c === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (d) document.documentElement.classList.add('dark'); } catch (e) {} })();
