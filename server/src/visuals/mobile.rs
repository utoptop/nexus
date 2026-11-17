use askama::Template;

#[derive(Template)]
#[template(path = "mobile.html")]
struct MobileTemplate<'a> {
    part: &'a str,
}

fn render(part: &str) -> String {
    MobileTemplate { part }.render().unwrap()
}

pub fn get_mobile_css() -> String { render("css") }
pub fn get_mobile_js() -> String { render("js") }
pub fn get_mobile_overlay() -> String { render("overlay") }
pub fn render_mobile_fab() -> String { render("fab") }
pub fn render_mobile_controls() -> String { render("controls") }
