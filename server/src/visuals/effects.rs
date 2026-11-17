pub const TRAJECTORY_JS: &str = r#"
        // Canvas parameters are numeric; zero brightness is a valid setting.
        function applyVisualStyles(dyn, res, time, init_speed, anim_speed, init_thick, res_thick, dash_length, dash_gap) {
            const number = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
            window.currentDynBright = number(dyn, 4, 0, 10);
            window.currentResBright = number(res, 3.5, 0, 10);
            window.currentResTimeMs = number(time, 3, 0.3, 30) * 1000;
            window.currentInitSpeed = number(init_speed, 0.1, 0.01, 5);
            window.currentAnimSpeed = number(anim_speed, 0.5, 0.01, 5);
            window.currentInitThick = number(init_thick, 1.5, 0.1, 8);
            window.currentResThick = number(res_thick, 0.5, 0.1, 5);
            window.currentDashLength = number(dash_length, 8, 1, 200);
            window.currentDashGap = number(dash_gap, 6, 0, 300);
            // Migrate the old comet's default spacing once; retain customized dash settings.
            if (!window.flashDashInitialized && window.currentDashLength === 20 && window.currentDashGap === 60) {
                window.currentDashLength = 8; window.currentDashGap = 6;
                for (const [key,value] of [['dash-length',8],['dash-gap',6]]) {
                    document.getElementById(key+'-slider').value=value;
                    document.getElementById(key+'-val').textContent=value+'px';
                }
            }
            window.flashDashInitialized = true;
            if (window.TrajectoryPool) window.TrajectoryPool.refreshStyle();
        }

        function updateVisuals() {
            const dyn = document.getElementById('dyn-bright-slider').value;
            const res = document.getElementById('res-bright-slider').value;
            const time = document.getElementById('res-time-slider').value;
            const init_speed = document.getElementById('init-speed-slider').value;
            const anim_speed = document.getElementById('anim-speed-slider').value;
            const init_thick = document.getElementById('init-thick-slider').value;
            const res_thick = document.getElementById('res-thick-slider').value;
            const dash_length = document.getElementById('dash-length-slider').value;
            const dash_gap = document.getElementById('dash-gap-slider').value;

            document.getElementById('dyn-bright-val').innerText = dyn;
            document.getElementById('res-bright-val').innerText = res;
            document.getElementById('res-time-val').innerText = time + 's';
            document.getElementById('init-speed-val').innerText = init_speed + 's';
            document.getElementById('anim-speed-val').innerText = anim_speed + 's';
            document.getElementById('init-thick-val').innerText = init_thick + 'px';
            document.getElementById('res-thick-val').innerText = res_thick + 'px';
            document.getElementById('dash-length-val').innerText = dash_length + 'px';
            document.getElementById('dash-gap-val').innerText = dash_gap + 'px';

            window.currentResTimeMs = parseFloat(time) * 1000;
            applyVisualStyles(dyn, res, time, init_speed, anim_speed, init_thick, res_thick, dash_length, dash_gap);

            clearTimeout(window.saveTimeout);
            window.saveTimeout = setTimeout(() => {
                const formData = new URLSearchParams();
                formData.append('dyn_bright', dyn); formData.append('res_bright', res); formData.append('res_time', time);
                formData.append('init_speed', init_speed); formData.append('anim_speed', anim_speed); formData.append('init_thick', init_thick);
                formData.append('res_thick', res_thick); formData.append('dash_length', dash_length); formData.append('dash_gap', dash_gap);
                fetch('__ADMIN_BASE__/settings/visuals', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString() });
            }, 500);
        }

        function resetVisuals() {
            document.getElementById('dyn-bright-slider').value = 4.0; document.getElementById('res-bright-slider').value = 3.5;
            document.getElementById('res-time-slider').value = 3.0; document.getElementById('init-speed-slider').value = 0.1;
            document.getElementById('anim-speed-slider').value = 0.5; document.getElementById('init-thick-slider').value = 1.5;
            document.getElementById('res-thick-slider').value = 0.5; document.getElementById('dash-length-slider').value = 8.0;
            document.getElementById('dash-gap-slider').value = 6.0; updateVisuals();
        }
"#;
