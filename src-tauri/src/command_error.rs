use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandErrorCode {
    Cancelled,
    InvalidInput,
    Storage,
    Database,
    System,
    Ocr,
    Serialization,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub message: String,
}

impl CommandError {
    fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Cancelled, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::InvalidInput, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Storage, message)
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Database, message)
    }

    pub fn system(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::System, message)
    }

    pub fn ocr(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Ocr, message)
    }

    pub fn serialization(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Serialization, message)
    }
}

impl Display for CommandError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

#[cfg(test)]
mod tests {
    use super::{CommandError, CommandErrorCode};

    #[test]
    fn command_errors_serialize_to_a_stable_code_and_message() {
        let error = CommandError::invalid_input("OCR text is empty");

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code": "invalid_input",
                "message": "OCR text is empty"
            })
        );
    }

    #[test]
    fn command_error_categories_remain_distinct() {
        assert_eq!(
            CommandError::cancelled("cancelled").code,
            CommandErrorCode::Cancelled
        );
        assert_eq!(
            CommandError::storage("storage").code,
            CommandErrorCode::Storage
        );
        assert_eq!(
            CommandError::database("database").code,
            CommandErrorCode::Database
        );
        assert_eq!(
            CommandError::system("system").code,
            CommandErrorCode::System
        );
        assert_eq!(CommandError::ocr("ocr").code, CommandErrorCode::Ocr);
        assert_eq!(
            CommandError::serialization("serialization").code,
            CommandErrorCode::Serialization
        );
    }
}
